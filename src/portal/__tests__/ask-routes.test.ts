// src/portal/__tests__/ask-routes.test.ts
// Frente C (#98) — catch global na rota POST /portal/ask: nenhum caminho pode
// rejeitar sem resposta (Express 4 viraria unhandled rejection). Erro
// inesperado → 500 {error:"unexpected"} + log com stack.
// Pool em memória (sessão) — sem rede/DB reais.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

process.env.SECRETS_KEY = "0".repeat(64);
process.env.PLAN_ENFORCEMENT = "off"; // pula o gate de créditos (sem DB)

import { createPortalRouter } from "../routes.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { __setAskDepsForTest } from "../ask.js";
import { hashSession } from "../session.js";

const SID = "test-session-ask-routes";
const ACCOUNT = "acct_ask_routes";

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        return params[0] === hashSession(SID)
          ? { rows: [{ account_id: ACCOUNT }] }
          : { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(createPortalRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  __setPoolForTest(null);
  __setAskDepsForTest(null);
});

beforeEach(() => {
  __setPoolForTest(memPool() as never);
});

const cookie = { cookie: `portal_session=${SID}`, "content-type": "application/json" };

test("erro inesperado no handleAsk → 500 {error:\"unexpected\"} (sem rejection pendurada)", async () => {
  // search lança erro genérico (não-quota): handleAsk relança (`throw e`);
  // sem o catch global a rota viraria unhandled rejection sem resposta.
  __setAskDepsForTest({
    search: async () => { throw new Error("pg connection refused"); },
    complete: async () => "nunca chega aqui",
    classify: async () => "search",
  });
  const realConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const res = await fetch(`${base}/portal/ask`, {
      method: "POST",
      headers: cookie,
      body: JSON.stringify({ question: "Qual o status do projeto?" }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: "unexpected" });
    const hit = logged.find((args) => String(args[0]).includes("[portal/ask] unexpected:"));
    assert.ok(hit, "deve logar [portal/ask] unexpected: com o erro");
    assert.ok(
      hit!.some((a) => String(a).includes("pg connection refused")),
      "log deve conter a causa real",
    );
  } finally {
    console.error = realConsoleError;
    __setAskDepsForTest(null);
  }
});

test("caminho feliz continua funcionando através do wrapper", async () => {
  __setAskDepsForTest({
    search: async () => [{
      chunk_id: "c1",
      title: "Nota",
      text: "Detalhes do projeto.",
      score: 0.9,
      source_url: "https://notion.so/x",
      notion_url: "https://notion.so/x",
      source_type: "notion",
      workspace: "personal",
      db: "Reunioes",
      metadata: {},
      neighbors: [],
    }],
    complete: async () => "Resposta em [1].",
    classify: async () => "search",
  });
  try {
    const res = await fetch(`${base}/portal/ask`, {
      method: "POST",
      headers: cookie,
      body: JSON.stringify({ question: "Qual o status do projeto?" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.route, "search");
    assert.ok(typeof body.answer === "string");
  } finally {
    __setAskDepsForTest(null);
  }
});

test("sem sessão → 401 (contrato existente preservado)", async () => {
  const res = await fetch(`${base}/portal/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "Qual o status?" }),
  });
  assert.equal(res.status, 401);
});
