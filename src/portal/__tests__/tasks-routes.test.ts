// src/portal/__tests__/tasks-routes.test.ts
// 003-tasks-v1 — rotas /portal/tasks/info|upgrade|use: exigem sessão, escopadas
// na conta da sessão, e /use grava + devolve o shape do info (validação via
// adapter). Pool em memória + fetch global stubado (sem rede/DB reais).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

process.env.SECRETS_KEY = "0".repeat(64);

import { createPortalRouter } from "../routes.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { __clearAccountTokenCache } from "../../account-tokens.js";
import { __clearTrackerProfileCache } from "../../tasks/adapter.js";
import { hashSession } from "../session.js";
import { SCHEMA_STANDARD_OLD } from "../../tasks/__tests__/fixtures.js";

const SID = "test-session-tasks";
const ACCOUNT = "acct_tasks_routes";

let store: Map<string, string>; // `${account}|${kind}` -> enc_value
let workspaces: string[];

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        return params[0] === hashSession(SID)
          ? { rows: [{ account_id: ACCOUNT }] }
          : { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/FROM account_workspaces/i.test(sql)) {
        return { rows: workspaces.map((w) => ({ workspace: w })) };
      }
      return { rows: [] };
    },
  };
}

let server: Server;
let base = "";
const realFetch = globalThis.fetch;

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
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  store = new Map();
  workspaces = [];
  __setPoolForTest(memPool() as never);
  __clearAccountTokenCache();
  __clearTrackerProfileCache();
  globalThis.fetch = realFetch;
});

const cookie = { cookie: `portal_session=${SID}` };

async function seedNotion() {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret(ACCOUNT, "notion_pat:ws-1", "ntn_fake");
  workspaces = ["ws-1"];
}

/** Stub do fetch global APENAS para api.notion.com (rotas usam fetch default). */
function stubNotion(handler: (url: string, init?: any) => { status?: number; body?: unknown } | undefined) {
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith("https://api.notion.com")) {
      const r = handler(u, init) ?? {};
      const status = r.status ?? 200;
      return new Response(JSON.stringify(r.body ?? {}), { status });
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

test("sem sessão → 401 nas três rotas", async () => {
  for (const [method, path] of [
    ["GET", "/portal/tasks/info"],
    ["POST", "/portal/tasks/upgrade"],
    ["POST", "/portal/tasks/use"],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("GET /portal/tasks/info sem tracker → configured:false (sem 500)", async () => {
  await seedNotion();
  const res = await fetch(`${base}/portal/tasks/info`, { headers: cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    configured: false,
    title: null,
    url: null,
    mapped: [],
    missing: [],
    is_standard: false,
  });
});

test("POST /portal/tasks/use sem data_source_id → 400", async () => {
  const res = await fetch(`${base}/portal/tasks/use`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /portal/tasks/use grava e devolve o shape do info (mapeado/faltando)", async () => {
  await seedNotion();
  stubNotion((url, init) => {
    if (init?.method === "GET" && url.includes("/v1/data_sources/ds-old")) {
      return { body: SCHEMA_STANDARD_OLD };
    }
    return undefined;
  });
  const res = await fetch(`${base}/portal/tasks/use`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: JSON.stringify({ data_source_id: "ds-old" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.title, "Tarefas");
  assert.equal(body.is_standard, true);
  assert.ok(body.mapped.includes("status"));
  assert.ok(body.missing.includes("prioridade"));
  // gravou no vault da CONTA DA SESSÃO
  const { getTasksDbId } = await import("../task-tracker.js");
  assert.equal(await getTasksDbId(ACCOUNT), "ds-old");
});

test("POST /portal/tasks/use: base ilegível → 400 unreadable e NÃO grava o vault", async () => {
  await seedNotion();
  stubNotion(() => ({ status: 503, body: {} })); // Notion fora do ar na validação
  const res = await fetch(`${base}/portal/tasks/use`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: JSON.stringify({ data_source_id: "ds-old" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "unreadable");
  assert.match(body.message, /não consegui ler essa base/);
  const { getTasksDbId } = await import("../task-tracker.js");
  assert.equal(await getTasksDbId(ACCOUNT), null, "vault não pode ser gravado");
});

test("POST /portal/tasks/use: sem Notion conectado → 400 unreadable (nada gravado)", async () => {
  // Sem seedNotion: a conta não tem token → a leitura de validação falha.
  const res = await fetch(`${base}/portal/tasks/use`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: JSON.stringify({ data_source_id: "ds-old" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "unreadable");
  const { getTasksDbId } = await import("../task-tracker.js");
  assert.equal(await getTasksDbId(ACCOUNT), null);
});

test("POST /portal/tasks/upgrade: base não-padrão → 400 com erro claro; padrão → ok/added", async () => {
  await seedNotion();
  const { setTasksDbId } = await import("../task-tracker.js");
  await setTasksDbId(ACCOUNT, "ds-old");

  // 1) tracker é "Tarefas" → upgrade roda e devolve added
  const patches: any[] = [];
  stubNotion((url, init) => {
    if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_STANDARD_OLD };
    if (init?.method === "PATCH" && url.includes("/v1/data_sources/")) {
      patches.push(JSON.parse(init.body));
      return { body: {} };
    }
    return undefined;
  });
  const ok = await fetch(`${base}/portal/tasks/upgrade`, { method: "POST", headers: cookie });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.ok(okBody.added.includes("Prioridade"));
  assert.equal(patches.length, 1);

  // 2) base do usuário (título ≠ Tarefas) → recusa
  __clearTrackerProfileCache();
  stubNotion((url, init) => {
    if (init?.method === "GET" && url.includes("/v1/data_sources/")) {
      return { body: { ...SCHEMA_STANDARD_OLD, title: [{ plain_text: "Meu CRM" }] } };
    }
    return undefined;
  });
  const bad = await fetch(`${base}/portal/tasks/upgrade`, { method: "POST", headers: cookie });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.match(badBody.error, /Tarefas/);
});
