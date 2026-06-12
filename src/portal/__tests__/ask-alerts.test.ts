// src/portal/__tests__/ask-alerts.test.ts
// Frente C (#98) — alerta ntfy em falha de LLM no /portal/ask, com throttle
// de 10 min (estado em memória, clock injetado). Sem rede: notify mockado.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { alertLlmFailure, __setAlertDepsForTest } from "../ask-alerts.js";

let sent: { message: string; title?: string }[];
let now: number;

beforeEach(() => {
  sent = [];
  now = 1_000_000;
  __setAlertDepsForTest({
    now: () => now,
    notify: async (message, opts) => { sent.push({ message, title: opts?.title }); },
  });
});

afterEach(() => {
  __setAlertDepsForTest(null);
});

test("primeira falha dispara alerta com contexto e mensagem do erro", () => {
  const fired = alertLlmFailure("search", new Error("credit balance too low"));
  assert.equal(fired, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.includes("search"), "deve incluir o contexto");
  assert.ok(sent[0].message.includes("credit balance too low"), "deve incluir a mensagem do erro");
});

test("segunda falha dentro de 10 min é suprimida (throttle)", () => {
  alertLlmFailure("search", new Error("boom"));
  now += 9 * 60 * 1000; // 9 min depois
  const fired = alertLlmFailure("search", new Error("boom 2"));
  assert.equal(fired, false);
  assert.equal(sent.length, 1, "só o primeiro alerta sai");
});

test("falha após 10 min dispara de novo", () => {
  alertLlmFailure("search", new Error("boom"));
  now += 10 * 60 * 1000; // exatamente 10 min depois
  const fired = alertLlmFailure("meta", new Error("boom de novo"));
  assert.equal(fired, true);
  assert.equal(sent.length, 2);
});

test("erro não-Error vira string na mensagem", () => {
  alertLlmFailure("search", "string error");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.includes("string error"));
});

test("notify que rejeita não derruba o caller", () => {
  __setAlertDepsForTest({
    now: () => now,
    notify: async () => { throw new Error("ntfy down"); },
  });
  assert.doesNotThrow(() => alertLlmFailure("search", new Error("boom")));
});

// Integração: handleAsk dispara o alerta quando a LLM falha na rota search.
import { handleAsk, __setAskDepsForTest } from "../ask.js";
import type { BrainResult } from "../../rag/brain-format.js";

test("handleAsk: falha de LLM na rota search dispara alerta ntfy", async () => {
  const hit: BrainResult = {
    chunk_id: "c1",
    title: "T",
    text: "texto",
    score: 0.9,
    source_url: "https://notion.so/x",
    notion_url: "https://notion.so/x",
    source_type: "notion",
    workspace: "personal",
    db: "Reunioes",
    metadata: {},
    neighbors: [],
  };
  __setAskDepsForTest({
    search: async () => [hit],
    complete: async () => { throw new Error("credit balance too low"); },
    classify: async () => "search",
  });
  const realConsoleError = console.error;
  console.error = () => {};
  const calls: { status?: number; json?: unknown } = {};
  const res: any = {
    locals: { accountId: "friend:test" },
    status(code: number) { calls.status = code; return res; },
    json(data: unknown) { calls.json = data; return res; },
  };
  try {
    await handleAsk({ body: { question: "Qual o status do projeto?" } } as any, res);
    assert.equal(sent.length, 1, "deve disparar 1 alerta ntfy");
    assert.ok(sent[0].message.includes("credit balance too low"));
  } finally {
    console.error = realConsoleError;
    __setAskDepsForTest(null);
  }
});
