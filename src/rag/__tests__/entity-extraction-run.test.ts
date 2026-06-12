// src/rag/__tests__/entity-extraction-run.test.ts
// Frente D (#99) — extração de entidades multi-conta.
//
// Cobre:
//   1. runEntityExtraction seleciona contas a partir de brain_chunks pendentes
//      (chunks sem entity_mentions), NÃO da tabela account — cobre friend:*.
//   2. Contas com 0 entidades são processadas primeiro (backfill natural).
//   3. Orçamento por conta (ENTITY_BUDGET_PER_ACCOUNT) e orçamento global por run.
//   4. Erro de LLM → 1 linha de log agregada POR CONTA (não por chunk); o run
//      segue para a próxima conta e os chunks ficam para o próximo cron.
//   5. Cada conta roda dentro do requestContext com o accountId correto.
//   6. extractEntitiesForAccount: circuit breaker após N erros consecutivos,
//      sem log por chunk, e LIMIT = orçamento injetado.
//
// Padrão de DI dos testes existentes: __setPoolForTest + deps injetadas.
import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import { getAccountId } from "../../context.js";
import {
  extractEntitiesForAccount,
  runEntityExtraction,
  type ExtractionStats,
} from "../entity-extractor.js";

const zeroStats = (): ExtractionStats => ({ chunksProcessed: 0, entitiesUpserted: 0, errors: 0 });

const savedEnv = {
  ENTITIES_ENABLED: process.env.ENTITIES_ENABLED,
  ENTITY_BUDGET_PER_ACCOUNT: process.env.ENTITY_BUDGET_PER_ACCOUNT,
  ENTITY_BUDGET_GLOBAL: process.env.ENTITY_BUDGET_GLOBAL,
  ENTITIES_BATCH_SIZE: process.env.ENTITIES_BATCH_SIZE,
};

afterEach(() => {
  __setPoolForTest(null);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  mock.restoreAll();
});

function pendingRows(rows: Array<{ account_id: string; pending: number; entity_count: number }>) {
  return rows;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test("runEntityExtraction não toca o banco quando ENTITIES_ENABLED não é true", async () => {
  delete process.env.ENTITIES_ENABLED;
  let queried = false;
  __setPoolForTest({ query: async () => { queried = true; return { rows: [] }; } } as never);

  const run = await runEntityExtraction();
  assert.equal(run.accounts, 0);
  assert.equal(run.chunksProcessed, 0);
  assert.equal(queried, false, "não deve consultar o pool com a flag desligada");
});

// ---------------------------------------------------------------------------
// Seleção de contas
// ---------------------------------------------------------------------------

test("runEntityExtraction seleciona contas via brain_chunks pendentes (inclui friend:*), não via tabela account", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const sqls: string[] = [];
  __setPoolForTest({
    query: async (sql: string) => {
      sqls.push(sql);
      return {
        rows: pendingRows([
          { account_id: "bruno", pending: 500, entity_count: 120 },
          { account_id: "friend:0fde0b29", pending: 8628, entity_count: 0 },
        ]),
      };
    },
  } as never);

  const calls: string[] = [];
  const run = await runEntityExtraction({
    extractForAccount: async (accountId) => { calls.push(accountId); return zeroStats(); },
  });

  assert.equal(run.accounts, 2);
  assert.ok(calls.includes("friend:0fde0b29"), "conta friend deve ser processada");
  assert.ok(calls.includes("bruno"), "conta do operador também é processada");

  const selectSql = sqls[0];
  assert.match(selectSql, /FROM brain_chunks/i, "seleção deve partir de brain_chunks");
  assert.match(selectSql, /entity_mentions/i, "seleção deve filtrar chunks sem entity_mentions");
  assert.doesNotMatch(selectSql, /FROM account\b/i, "seleção não pode partir da tabela account");
});

test("runEntityExtraction processa primeiro contas com 0 entidades (backfill natural)", async () => {
  process.env.ENTITIES_ENABLED = "true";
  __setPoolForTest({
    query: async () => ({
      rows: pendingRows([
        { account_id: "bruno", pending: 500, entity_count: 120 },
        { account_id: "friend:zzz", pending: 10, entity_count: 4 },
        { account_id: "friend:0fde0b29", pending: 8628, entity_count: 0 },
      ]),
    }),
  } as never);

  const order: string[] = [];
  await runEntityExtraction({
    extractForAccount: async (accountId) => { order.push(accountId); return zeroStats(); },
  });

  assert.deepEqual(order, ["friend:0fde0b29", "friend:zzz", "bruno"]);
});

// ---------------------------------------------------------------------------
// Orçamentos
// ---------------------------------------------------------------------------

test("runEntityExtraction respeita ENTITY_BUDGET_PER_ACCOUNT do env", async () => {
  process.env.ENTITIES_ENABLED = "true";
  process.env.ENTITY_BUDGET_PER_ACCOUNT = "50";
  __setPoolForTest({
    query: async () => ({ rows: pendingRows([{ account_id: "friend:a", pending: 9000, entity_count: 0 }]) }),
  } as never);

  const budgets: number[] = [];
  await runEntityExtraction({
    extractForAccount: async (_accountId, budget) => { budgets.push(budget); return zeroStats(); },
  });

  assert.deepEqual(budgets, [50]);
});

test("runEntityExtraction respeita orçamento global por run", async () => {
  process.env.ENTITIES_ENABLED = "true";
  __setPoolForTest({
    query: async () => ({
      rows: pendingRows([
        { account_id: "a", pending: 8000, entity_count: 0 },
        { account_id: "b", pending: 8000, entity_count: 0 },
        { account_id: "c", pending: 8000, entity_count: 0 },
      ]),
    }),
  } as never);

  const calls: Array<{ accountId: string; budget: number }> = [];
  const run = await runEntityExtraction({
    perAccountBudget: 80,
    globalBudget: 100,
    extractForAccount: async (accountId, budget) => {
      calls.push({ accountId, budget });
      return { chunksProcessed: budget, entitiesUpserted: 0, errors: 0 };
    },
  });

  // a consome 80, sobra 20 para b; c fica para o próximo run.
  assert.deepEqual(calls, [
    { accountId: "a", budget: 80 },
    { accountId: "b", budget: 20 },
  ]);
  assert.equal(run.chunksProcessed, 100);
});

// ---------------------------------------------------------------------------
// Agregação de erros
// ---------------------------------------------------------------------------

test("runEntityExtraction loga 1 linha agregada por conta com erro (não por chunk)", async () => {
  process.env.ENTITIES_ENABLED = "true";
  __setPoolForTest({
    query: async () => ({
      rows: pendingRows([
        { account_id: "friend:a", pending: 300, entity_count: 0 },
        { account_id: "friend:b", pending: 300, entity_count: 0 },
      ]),
    }),
  } as never);

  const logged: string[] = [];
  const run = await runEntityExtraction({
    log: (line) => logged.push(line),
    extractForAccount: async () => ({
      chunksProcessed: 0,
      entitiesUpserted: 0,
      errors: 200,
      lastError: "400 credit balance is too low",
    }),
  });

  assert.equal(logged.length, 2, "exatamente 1 linha por conta com erro");
  assert.match(logged[0], /friend:a/);
  assert.match(logged[0], /credit balance/);
  assert.match(logged[1], /friend:b/);
  assert.equal(run.errors, 400);
  // Chunks pendentes continuam sem entity_mentions → próximo cron tenta de novo.
});

test("runEntityExtraction não loga linha de erro para conta sem erros", async () => {
  process.env.ENTITIES_ENABLED = "true";
  __setPoolForTest({
    query: async () => ({ rows: pendingRows([{ account_id: "friend:a", pending: 10, entity_count: 0 }]) }),
  } as never);

  const logged: string[] = [];
  await runEntityExtraction({
    log: (line) => logged.push(line),
    extractForAccount: async () => ({ chunksProcessed: 10, entitiesUpserted: 5, errors: 0 }),
  });

  assert.equal(logged.length, 0);
});

test("runEntityExtraction segue para a próxima conta se extractForAccount lançar", async () => {
  process.env.ENTITIES_ENABLED = "true";
  __setPoolForTest({
    query: async () => ({
      rows: pendingRows([
        { account_id: "friend:a", pending: 10, entity_count: 0 },
        { account_id: "friend:b", pending: 10, entity_count: 0 },
      ]),
    }),
  } as never);

  const logged: string[] = [];
  const calls: string[] = [];
  const run = await runEntityExtraction({
    log: (line) => logged.push(line),
    extractForAccount: async (accountId) => {
      calls.push(accountId);
      if (accountId === "friend:a") throw new Error("boom");
      return { chunksProcessed: 10, entitiesUpserted: 1, errors: 0 };
    },
  });

  assert.deepEqual(calls, ["friend:a", "friend:b"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /friend:a/);
  assert.match(logged[0], /boom/);
  assert.equal(run.chunksProcessed, 10);
});

// ---------------------------------------------------------------------------
// Isolamento: requestContext por conta
// ---------------------------------------------------------------------------

test("runEntityExtraction roda cada conta dentro do requestContext do account correto", async () => {
  process.env.ENTITIES_ENABLED = "true";
  __setPoolForTest({
    query: async () => ({
      rows: pendingRows([
        { account_id: "friend:0fde0b29", pending: 100, entity_count: 0 },
        { account_id: "bruno", pending: 100, entity_count: 9 },
      ]),
    }),
  } as never);

  const seen: string[] = [];
  await runEntityExtraction({
    extractForAccount: async () => { seen.push(getAccountId()); return zeroStats(); },
  });

  assert.deepEqual(seen, ["friend:0fde0b29", "bruno"]);
});

// ---------------------------------------------------------------------------
// extractEntitiesForAccount — orçamento + circuit breaker
// ---------------------------------------------------------------------------

test("extractEntitiesForAccount usa o orçamento injetado como LIMIT", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const captured: unknown[][] = [];
  __setPoolForTest({
    query: async (_sql: string, params: unknown[]) => {
      captured.push(params);
      return { rows: [{ id: "c1", text: "t", metadata: {} }] };
    },
  } as never);

  const stats = await extractEntitiesForAccount("friend:a", {
    budget: 7,
    extractChunk: async () => {},
  });

  assert.deepEqual(captured[0], ["friend:a", 7]);
  assert.equal(stats.chunksProcessed, 1);
});

test("extractEntitiesForAccount para após erros consecutivos de LLM e não loga por chunk", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const errSpy = mock.method(console, "error", () => {});
  const chunks = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: "t", metadata: {} }));
  __setPoolForTest({ query: async () => ({ rows: chunks }) } as never);

  let attempts = 0;
  const stats = await extractEntitiesForAccount("friend:a", {
    budget: 10,
    extractChunk: async () => { attempts++; throw new Error("400 credit balance is too low"); },
  });

  assert.equal(attempts, 3, "circuit breaker deve parar após 3 erros consecutivos");
  assert.equal(stats.errors, 3);
  assert.equal(stats.chunksProcessed, 0);
  assert.match(stats.lastError ?? "", /credit balance/);
  assert.equal(errSpy.mock.callCount(), 0, "sem log por chunk — agregação é no caller");
});

test("extractEntitiesForAccount zera o contador de erros consecutivos após sucesso", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const chunks = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, text: "t", metadata: {} }));
  __setPoolForTest({ query: async () => ({ rows: chunks }) } as never);

  // Falha, sucesso, falha, sucesso... nunca acumula 3 consecutivos.
  let i = 0;
  const stats = await extractEntitiesForAccount("friend:a", {
    budget: 6,
    extractChunk: async () => { if (i++ % 2 === 0) throw new Error("flaky"); },
  });

  assert.equal(stats.chunksProcessed, 3);
  assert.equal(stats.errors, 3);
});

test("extractEntitiesForAccount respeita gate em runtime (sem flag não consulta o banco)", async () => {
  delete process.env.ENTITIES_ENABLED;
  let queried = false;
  __setPoolForTest({ query: async () => { queried = true; return { rows: [] }; } } as never);

  const stats = await extractEntitiesForAccount("friend:a", { budget: 5 });
  assert.equal(stats.chunksProcessed, 0);
  assert.equal(queried, false);
});

// ---------------------------------------------------------------------------
// Marcador entity_extraction_done — extração com zero entidades não cria
// entity_mention, então sem o marcador o chunk era re-selecionado (e re-pago
// no LLM) em todo run e o loop do backfill nunca terminava.
// ---------------------------------------------------------------------------

test("chunk processado com sucesso é marcado em entity_extraction_done (mesmo com zero entidades)", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT bc.id")) {
        return {
          rows: [
            { id: "c1", text: "t", metadata: {} },
            { id: "c2", text: "t", metadata: {} },
          ],
        };
      }
      return { rows: [] };
    },
  } as never);

  const stats = await extractEntitiesForAccount("friend:a", { extractChunk: async () => {} });

  const dones = calls.filter(
    (c) => c.sql.includes("INSERT INTO entity_extraction_done"),
  );
  assert.equal(stats.chunksProcessed, 2);
  assert.deepEqual(
    dones.map((c) => c.params),
    [["c1", "friend:a"], ["c2", "friend:a"]],
  );
});

test("chunk com erro de LLM NÃO é marcado como done (fica pendente para o próximo run)", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT bc.id")) {
        return {
          rows: [
            { id: "ok1", text: "t", metadata: {} },
            { id: "boom", text: "t", metadata: {} },
          ],
        };
      }
      return { rows: [] };
    },
  } as never);

  const stats = await extractEntitiesForAccount("friend:a", {
    extractChunk: async (chunkId: string) => {
      if (chunkId === "boom") throw new Error("llm down");
    },
  });

  const doneIds = calls
    .filter((c) => c.sql.includes("INSERT INTO entity_extraction_done"))
    .map((c) => c.params[0]);
  assert.equal(stats.chunksProcessed, 1);
  assert.equal(stats.errors, 1);
  assert.deepEqual(doneIds, ["ok1"]);
});

test("seleção de chunks e de contas excluem chunks já marcados como done", async () => {
  process.env.ENTITIES_ENABLED = "true";
  const selects: string[] = [];
  __setPoolForTest({
    query: async (sql: string) => {
      selects.push(sql);
      return { rows: [] };
    },
  } as never);

  await extractEntitiesForAccount("friend:a", { extractChunk: async () => {} });
  const chunkSelect = selects.find((s) => s.includes("SELECT bc.id"));
  assert.match(chunkSelect ?? "", /NOT EXISTS[\s\S]*entity_extraction_done/);

  selects.length = 0;
  await runEntityExtraction();
  const accountSelect = selects.find((s) => s.includes("GROUP BY bc.account_id"));
  assert.match(accountSelect ?? "", /NOT EXISTS[\s\S]*entity_extraction_done/);
});
