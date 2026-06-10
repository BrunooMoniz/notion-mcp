// src/portal/__tests__/ask-e3.test.ts
// E3 — Testes unitários: roteador de intenção, relevância/dedup, histórico, ações.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterAndDedup,
  askMinScore,
  truncateHistory,
  classifyIntentFull,
  __setAskDepsForTest,
  handleAsk,
  type ChatMessage,
} from "../ask.js";
import type { BrainResult } from "../../rag/brain-format.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHit(overrides: Partial<BrainResult> & { score?: number } = {}): BrainResult {
  return {
    title: "Título de teste",
    text: "Texto de exemplo para o chunk.",
    score: overrides.score ?? 0.8,
    source_url: overrides.source_url ?? "https://notion.so/page-123",
    notion_url: overrides.source_url ?? "https://notion.so/page-123",
    source_type: overrides.source_type ?? "notion",
    workspace: "personal",
    db: "Reunioes",
    metadata: overrides.metadata ?? {},
    neighbors: [],
    ...overrides,
  };
}

function mockReq(body: Record<string, unknown>) {
  return { body } as any;
}

function mockRes(accountId = "friend:test") {
  const calls: { status?: number; json?: unknown } = {};
  const res: any = {
    locals: { accountId },
    status(code: number) { calls.status = code; return res; },
    json(data: unknown) { calls.json = data; return res; },
    _calls: calls,
  };
  return res;
}

// ---------------------------------------------------------------------------
// 3.2 — filterAndDedup
// ---------------------------------------------------------------------------

test("filterAndDedup: remove hits com score abaixo do threshold", () => {
  const hits = [
    makeHit({ score: 0.8, source_url: "https://a.com" }),
    makeHit({ score: 0.2, source_url: "https://b.com" }),
    makeHit({ score: 0.35, source_url: "https://c.com" }),
  ];
  const result = filterAndDedup(hits, 0.35);
  assert.equal(result.length, 2, "deve manter score >= 0.35");
  assert.ok(result.every((h) => h.score >= 0.35));
});

test("filterAndDedup: dedup por source_url mantém melhor chunk", () => {
  const hits = [
    makeHit({ score: 0.7, source_url: "https://notion.so/canelinha", title: "Canelinha chunk 1" }),
    makeHit({ score: 0.6, source_url: "https://notion.so/canelinha", title: "Canelinha chunk 2" }),
    makeHit({ score: 0.9, source_url: "https://notion.so/canelinha", title: "Canelinha chunk 3" }),
    makeHit({ score: 0.8, source_url: "https://notion.so/outro", title: "Outro doc" }),
  ];
  const result = filterAndDedup(hits, 0.35);
  assert.equal(result.length, 2, "deve ter 1 chunk por source_url");
  const canelinha = result.find((h) => h.source_url === "https://notion.so/canelinha");
  assert.ok(canelinha);
  assert.equal(canelinha!.score, 0.9, "deve manter o melhor chunk (score 0.9)");
});

test("filterAndDedup: resultado vazio quando todos abaixo do threshold", () => {
  const hits = [
    makeHit({ score: 0.1 }),
    makeHit({ score: 0.2 }),
  ];
  const result = filterAndDedup(hits, 0.35);
  assert.equal(result.length, 0);
});

test("filterAndDedup: ordenado por score desc", () => {
  const hits = [
    makeHit({ score: 0.5, source_url: "https://a.com" }),
    makeHit({ score: 0.9, source_url: "https://b.com" }),
    makeHit({ score: 0.7, source_url: "https://c.com" }),
  ];
  const result = filterAndDedup(hits, 0.35);
  assert.equal(result[0].score, 0.9);
  assert.equal(result[1].score, 0.7);
  assert.equal(result[2].score, 0.5);
});

test("askMinScore: default é 0.35", () => {
  delete process.env.ASK_MIN_SCORE;
  assert.equal(askMinScore(), 0.35);
});

test("askMinScore: lê do env ASK_MIN_SCORE", () => {
  process.env.ASK_MIN_SCORE = "0.5";
  assert.equal(askMinScore(), 0.5);
  delete process.env.ASK_MIN_SCORE;
});

// ---------------------------------------------------------------------------
// 3.1 — Roteador de intenção via deps.classify
// ---------------------------------------------------------------------------

test("handler: route=meta não chama search (dep mockada)", async () => {
  let searchCalled = false;
  __setAskDepsForTest({
    search: async () => { searchCalled = true; return []; },
    complete: async () => "Sou o Zinom, um assistente pessoal.",
    classify: async () => "meta",
  });
  const res = mockRes();
  try {
    await handleAsk(mockReq({ question: "Como você funciona?" }), res);
    assert.equal(searchCalled, false, "search NÃO deve ser chamada para rota meta");
    const body = res._calls.json as any;
    assert.equal(body.route, "meta");
    assert.ok(Array.isArray(body.sources) && body.sources.length === 0, "meta não deve ter fontes");
  } finally {
    __setAskDepsForTest(null);
  }
});

test("handler: route=search chama search e retorna fontes", async () => {
  const fakeHit = makeHit({ score: 0.9, title: "Nota relevante", text: "Detalhes do projeto." });
  __setAskDepsForTest({
    search: async () => [fakeHit],
    complete: async () => "A resposta foi encontrada em [1].",
    classify: async () => "search",
  });
  const res = mockRes();
  try {
    await handleAsk(mockReq({ question: "Qual o status do projeto?" }), res);
    const body = res._calls.json as any;
    assert.equal(body.route, "search");
    assert.ok(Array.isArray(body.sources) && body.sources.length >= 1, "deve ter fontes");
  } finally {
    __setAskDepsForTest(null);
  }
});

test("handler: route=action retorna proposed_action sem chamar search", async () => {
  let searchCalled = false;
  const fakeAction = {
    type: "criar_evento" as const,
    params: { summary: "Reunião com João", date_raw: "amanhã 14h" },
    resumo: "Reunião com João amanhã às 14h",
  };
  __setAskDepsForTest({
    search: async () => { searchCalled = true; return []; },
    complete: async (_sys: string, user: string) => {
      // Quando chamado para classificação completa (classifyIntentFull), retornar action JSON
      return JSON.stringify({ route: "action", action: fakeAction });
    },
    classify: async () => "action",
  });
  const res = mockRes();
  try {
    await handleAsk(mockReq({ question: "Cria um evento para reunião com João amanhã às 14h" }), res);
    assert.equal(searchCalled, false, "search NÃO deve ser chamada para rota action");
    const body = res._calls.json as any;
    assert.equal(body.route, "action");
    assert.ok(body.proposed_action, "deve ter proposed_action");
  } finally {
    __setAskDepsForTest(null);
  }
});

// ---------------------------------------------------------------------------
// 3.2 — Resposta honesta quando nada passa do corte
// ---------------------------------------------------------------------------

test("handler: hits abaixo do threshold → resposta honesta sem fontes", async () => {
  // Todos com score abaixo do default 0.35
  const lowScoreHit = makeHit({ score: 0.1 });
  __setAskDepsForTest({
    search: async () => [lowScoreHit],
    complete: async () => "resposta",
    classify: async () => "search",
  });
  process.env.ASK_MIN_SCORE = "0.35";
  const res = mockRes();
  try {
    await handleAsk(mockReq({ question: "Pergunta qualquer?" }), res);
    const body = res._calls.json as any;
    assert.ok(
      body.answer.toLowerCase().includes("não encontrei"),
      `deve dizer não encontrei, mas foi: ${body.answer}`,
    );
    assert.equal(body.sources.length, 0);
  } finally {
    __setAskDepsForTest(null);
    delete process.env.ASK_MIN_SCORE;
  }
});

// ---------------------------------------------------------------------------
// 3.5 — Histórico de conversa / truncateHistory
// ---------------------------------------------------------------------------

test("truncateHistory: mantém no máximo 6 mensagens", () => {
  const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Mensagem ${i}`,
  }));
  const result = truncateHistory(history, 6);
  assert.equal(result.length, 6, "deve manter 6 mensagens");
  // Deve ser as últimas 6
  assert.equal(result[0].content, "Mensagem 4");
});

test("truncateHistory: trunca por chars quando excede maxChars", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "a".repeat(5000) },
    { role: "assistant", content: "b".repeat(5000) },
    { role: "user", content: "Pergunta curta" },
  ];
  const result = truncateHistory(history, 6, 8000);
  // A 3ª mensagem (curta) + a 2ª (5000 chars) = 5014 <= 8000, mas a 1ª (5000) tornaria total > 8000
  assert.ok(result.length <= 2, `deve ter no máximo 2 mensagens (total chars > 8000 com as 3), mas foi ${result.length}`);
  assert.equal(result[result.length - 1].content, "Pergunta curta");
});

test("truncateHistory: history vazio retorna vazio", () => {
  assert.deepEqual(truncateHistory([]), []);
});

test("handler: history inválido (não-array) é ignorado silenciosamente", async () => {
  __setAskDepsForTest({
    search: async () => [makeHit({ score: 0.9 })],
    complete: async () => "resposta sem citações",
    classify: async () => "search",
  });
  const res = mockRes();
  try {
    await handleAsk(mockReq({ question: "Qual o status?", history: "invalid" }), res);
    // Não deve lançar erro
    assert.ok(res._calls.json, "deve responder normalmente");
  } finally {
    __setAskDepsForTest(null);
  }
});

// ---------------------------------------------------------------------------
// classifyIntentFull (parse de JSON)
// ---------------------------------------------------------------------------

test("classifyIntentFull: JSON action válido → extrai tipo e params", async () => {
  __setAskDepsForTest({
    complete: async () => JSON.stringify({
      route: "action",
      action: {
        type: "criar_evento",
        params: { summary: "Standup", date_raw: "amanhã 9h" },
        resumo: "Standup amanhã às 9h",
      },
    }),
    search: async () => [],
    classify: async () => "action",
  });
  try {
    const result = await classifyIntentFull("cria evento standup amanhã às 9h");
    assert.equal(result.route, "action");
    assert.equal(result.action?.type, "criar_evento");
    assert.equal(result.action?.resumo, "Standup amanhã às 9h");
  } finally {
    __setAskDepsForTest(null);
  }
});

test("classifyIntentFull: JSON route=meta → sem action", async () => {
  __setAskDepsForTest({
    complete: async () => JSON.stringify({ route: "meta" }),
    search: async () => [],
    classify: async () => "meta",
  });
  try {
    const result = await classifyIntentFull("Como você funciona?");
    assert.equal(result.route, "meta");
    assert.equal(result.action, undefined);
  } finally {
    __setAskDepsForTest(null);
  }
});

test("classifyIntentFull: JSON malformado → fallback search", async () => {
  __setAskDepsForTest({
    complete: async () => "não é JSON",
    search: async () => [],
    classify: async () => "search",
  });
  try {
    const result = await classifyIntentFull("qualquer mensagem");
    assert.equal(result.route, "search");
  } finally {
    __setAskDepsForTest(null);
  }
});
