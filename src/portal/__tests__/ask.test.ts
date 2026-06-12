// src/portal/__tests__/ask.test.ts
// P1 — chat com o cérebro na tela logada. Pure unit tests (no DB, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAskContext, citedNumbers, toAskSources, __setAskDepsForTest } from "../ask.js";
import type { BrainResult } from "../../rag/brain-format.js";
import { QuotaExceededError } from "../../billing/usage.js";

// --- helpers ------------------------------------------------------------------

function makeHit(overrides: Partial<BrainResult> = {}): BrainResult {
  return {
    title: "Título de teste",
    text: "Texto de exemplo para o chunk.",
    score: 0.8,
    source_url: "https://notion.so/page-123",
    notion_url: "https://notion.so/page-123",
    source_type: "notion",
    workspace: "personal",
    db: "Reunioes",
    metadata: {},
    neighbors: [],
    ...overrides,
  };
}

// --- buildAskContext ----------------------------------------------------------

test("buildAskContext: numera de 1 e inclui título, source_type e texto", () => {
  const hits = [makeHit({ title: "Reunião Alpha", text: "Conteúdo A" })];
  const ctx = buildAskContext(hits);
  assert.ok(ctx.includes("[1]"), "deve ter número [1]");
  assert.ok(ctx.includes("Reunião Alpha"), "deve incluir o título");
  assert.ok(ctx.includes("notion"), "deve incluir source_type");
  assert.ok(ctx.includes("Conteúdo A"), "deve incluir o texto");
});

test("buildAskContext: aplica fence <<<untrusted>>> em fontes de terceiros (web, notion, granola, calendar)", () => {
  // F-3: notion/granola/calendar são terceiros e devem ser cercados, assim como web.
  // Apenas "conversation" (memória do próprio usuário) não recebe fence.
  const hits = [
    makeHit({ source_type: "web", title: "Artigo externo", text: "Texto web" }),
    makeHit({ source_type: "notion", title: "Nota Notion", text: "Texto notion" }),
    makeHit({ source_type: "conversation", title: "Memória", text: "Texto conversation" }),
  ];
  const ctx = buildAskContext(hits);

  const block1Start = ctx.indexOf("[1]");
  const block2Start = ctx.indexOf("[2]");
  const block3Start = ctx.indexOf("[3]");
  const block1 = ctx.slice(block1Start, block2Start);
  const block2 = ctx.slice(block2Start, block3Start);
  const block3 = ctx.slice(block3Start);

  assert.ok(block1.includes("<<<untrusted>>>"), "web deve ter fence untrusted");
  assert.ok(block2.includes("<<<untrusted>>>"), "notion deve ter fence untrusted (F-3)");
  assert.ok(!block3.includes("<<<untrusted>>>"), "conversation NÃO deve ter fence (memória do usuário)");
});

test("buildAskContext: inclui data quando metadata.data existe", () => {
  const hits = [makeHit({ metadata: { data: "2024-03-15" } })];
  const ctx = buildAskContext(hits);
  assert.ok(ctx.includes("2024-03-15"), "deve incluir a data");
});

test("buildAskContext: lista vazia retorna string vazia", () => {
  assert.equal(buildAskContext([]), "");
});

// --- citedNumbers -------------------------------------------------------------

test("citedNumbers: extrai números únicos e ordenados, ignora inválidos", () => {
  // "hits" tem 4 elementos — [9] está fora do range e deve ser ignorado
  const hits = [makeHit(), makeHit(), makeHit(), makeHit()];
  const answer = "Conforme [1] e [3], reiterando [1] de novo, e [9] irrelevante.";
  const cited = citedNumbers(answer, hits.length);
  assert.deepEqual(cited, [1, 3]);
});

test("citedNumbers: sem citações retorna array vazio", () => {
  assert.deepEqual(citedNumbers("Nenhuma citação aqui.", 5), []);
});

test("citedNumbers: todos os índices válidos são retornados", () => {
  assert.deepEqual(citedNumbers("[2] e [4] e [1]", 4), [1, 2, 4]);
});

test("citedNumbers: índice 0 é inválido (começa em 1)", () => {
  assert.deepEqual(citedNumbers("[0] algo [1]", 2), [1]);
});

// --- toAskSources -------------------------------------------------------------

test("toAskSources: monta fontes com snippet truncado em 500 chars", () => {
  const longText = "x".repeat(700);
  const hits = [makeHit({ text: longText, title: "Fonte longa" })];
  const cited = [1];
  const sources = toAskSources(hits, cited);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].n, 1);
  assert.equal(sources[0].snippet.length, 500);
  assert.equal(sources[0].cited, true);
  assert.equal(sources[0].title, "Fonte longa");
});

test("toAskSources: cited=false quando fonte não foi citada", () => {
  const hits = [makeHit(), makeHit()];
  const sources = toAskSources(hits, [1]); // apenas [1] citado
  assert.equal(sources[0].cited, true);
  assert.equal(sources[1].cited, false);
});

test("toAskSources: date = metadata.data quando presente, senão null", () => {
  const hits = [
    makeHit({ metadata: { data: "2024-01-10" } }),
    makeHit({ metadata: {} }),
  ];
  const sources = toAskSources(hits, []);
  assert.equal(sources[0].date, "2024-01-10");
  assert.equal(sources[1].date, null);
});

// --- handler mockado via __setAskDepsForTest ----------------------------------

// Importamos o handler diretamente e mockamos as deps para testar o fluxo HTTP.
import { handleAsk } from "../ask.js";

function mockReq(body: Record<string, unknown>, accountId = "friend:test") {
  return { body, locals: { accountId } } as any;
}

function mockRes() {
  const calls: { status?: number; json?: unknown } = {};
  const res: any = {
    locals: {},
    status(code: number) { calls.status = code; return res; },
    json(data: unknown) { calls.json = data; return res; },
    _calls: calls,
  };
  return res;
}

test("handler: 400 para question com menos de 3 chars", async () => {
  const res = mockRes();
  res.locals.accountId = "friend:test";
  await handleAsk(mockReq({ question: "ab" }, "friend:test"), res);
  assert.equal(res._calls.status, 400);
  assert.deepEqual(res._calls.json, { error: "invalid_question" });
});

test("handler: 400 para question ausente", async () => {
  const res = mockRes();
  res.locals.accountId = "friend:test";
  await handleAsk(mockReq({}, "friend:test"), res);
  assert.equal(res._calls.status, 400);
  assert.deepEqual(res._calls.json, { error: "invalid_question" });
});

test("handler: 402 quando search lança QuotaExceededError", async () => {
  __setAskDepsForTest({
    search: async () => { throw new QuotaExceededError("buscas/mês", 100, 100); },
    complete: async () => "resposta",
  });
  const res = mockRes();
  res.locals.accountId = "friend:test";
  try {
    await handleAsk(mockReq({ question: "Qual o status do projeto?" }, "friend:test"), res);
    assert.equal(res._calls.status, 402);
    assert.deepEqual(res._calls.json, { error: "quota" });
  } finally {
    __setAskDepsForTest(null);
  }
});

test("handler: 200 com answer e sources, cited correto", async () => {
  const fakeHit = makeHit({ title: "Nota relevante", text: "Detalhes do projeto." });
  __setAskDepsForTest({
    search: async () => [fakeHit],
    complete: async () => "A resposta foi encontrada em [1].",
  });
  const res = mockRes();
  res.locals.accountId = "friend:test";
  try {
    await handleAsk(mockReq({ question: "Qual o status?" }, "friend:test"), res);
    assert.equal(res._calls.status, undefined, "status deve ser omitido (200 implícito)");
    const body = res._calls.json as any;
    assert.ok(typeof body.answer === "string", "deve ter answer");
    assert.ok(Array.isArray(body.sources), "deve ter sources array");
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].cited, true, "fonte [1] deve estar cited=true");
    assert.equal(body.sources[0].n, 1);
  } finally {
    __setAskDepsForTest(null);
  }
});

// Frente C (#98): LLM falhou mas a busca achou resultados → 200 degradado,
// nunca 502 (o Cloudflare substitui 502/504 da origem pela página HTML dele).
test("handler: LLM falha com hits → 200 degradado com fontes (nunca 502)", async () => {
  const fakeHit = makeHit({ chunk_id: "chunk-degraded-1" } as any);
  __setAskDepsForTest({
    search: async () => [fakeHit],
    complete: async () => { throw new Error("LLM unavailable"); },
  });
  const res = mockRes();
  res.locals.accountId = "friend:test";
  try {
    await handleAsk(mockReq({ question: "Pergunta qualquer aqui" }, "friend:test"), res);
    assert.equal(res._calls.status, undefined, "deve ser 200 (status implícito), nunca 502");
    const body = res._calls.json as any;
    assert.equal(body.answer, null);
    assert.equal(body.degraded, true);
    assert.equal(body.reason, "llm_unavailable");
    assert.equal(body.route, "search");
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].chunk_id, "chunk-degraded-1", "fonte deve ter chunk_id para feedback");
    assert.equal(body.sources[0].cited, true);
  } finally {
    __setAskDepsForTest(null);
  }
});

test("handler: modo degradado marca cited só nas top min(5, N) fontes", async () => {
  // 6 hits com source_url distintos (sem dedup) e score acima do corte
  const hits = Array.from({ length: 6 }, (_, i) =>
    makeHit({
      chunk_id: `chunk-${i}`,
      score: 0.9 - i * 0.05,
      source_url: `https://notion.so/page-${i}`,
      notion_url: `https://notion.so/page-${i}`,
    } as any),
  );
  __setAskDepsForTest({
    search: async () => hits,
    complete: async () => { throw new Error("LLM unavailable"); },
  });
  const res = mockRes();
  res.locals.accountId = "friend:test";
  try {
    await handleAsk(mockReq({ question: "Pergunta qualquer aqui" }, "friend:test"), res);
    const body = res._calls.json as any;
    assert.equal(body.degraded, true);
    assert.equal(body.sources.length, 6, "todas as fontes filtradas voltam");
    assert.deepEqual(
      body.sources.map((s: any) => s.cited),
      [true, true, true, true, true, false],
      "apenas as top 5 ficam cited=true",
    );
  } finally {
    __setAskDepsForTest(null);
  }
});

test("handler: falha de LLM loga '[portal/ask] llm error:' com a causa real", async () => {
  const realConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  __setAskDepsForTest({
    search: async () => [makeHit()],
    complete: async () => { throw new Error("credit balance too low"); },
  });
  const res = mockRes();
  res.locals.accountId = "friend:test";
  try {
    await handleAsk(mockReq({ question: "Pergunta qualquer aqui" }, "friend:test"), res);
    const hit = logged.find((args) => String(args[0]).includes("[portal/ask] llm error:"));
    assert.ok(hit, "deve logar [portal/ask] llm error:");
    assert.ok(
      hit!.some((a) => String(a).includes("credit balance too low")),
      "log deve conter a mensagem real do erro",
    );
  } finally {
    console.error = realConsoleError;
    __setAskDepsForTest(null);
  }
});
