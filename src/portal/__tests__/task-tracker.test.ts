// src/portal/__tests__/task-tracker.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);

import {
  detectTaskTracker,
  getTasksDbId,
  setTasksDbId,
  createTaskTracker,
  useExistingTracker,
} from "../task-tracker.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { __clearAccountTokenCache } from "../../account-tokens.js";

let store: Map<string, string>; // `${account}|${kind}` -> enc_value
let workspaces: string[];

// Minimal pool: account_secrets vault + account_workspaces lookup used by warmAccount.
function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/DELETE FROM account_secrets/i.test(sql)) {
        store.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM account_workspaces/i.test(sql)) {
        return { rows: workspaces.map((w) => ({ workspace: w })) };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  store = new Map();
  workspaces = [];
  __setPoolForTest(memPool() as never);
  __clearAccountTokenCache();
});
afterEach(() => {
  __setPoolForTest(null);
  __clearAccountTokenCache();
});

// Seed a connected Notion workspace with a PAT in the vault, so warmAccount finds a token.
async function seedNotion(accountId: string, ws = "ws-1") {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret(accountId, `notion_pat:${ws}`, "ntn_fake");
  workspaces = [ws];
}

/** Fake fetch routed by URL substring → JSON body (function or value). */
function routeFetch(handler: (url: string, init?: any) => any): typeof fetch {
  return (async (url: string, init?: any) => {
    const body = handler(String(url), init);
    return { ok: true, status: 200, text: async () => JSON.stringify(body ?? {}) };
  }) as any;
}

test("detect: sem Notion conectado → no-notion (não chama a API)", async () => {
  const det = await detectTaskTracker("friend:x", { fetchImpl: routeFetch(() => ({})) });
  assert.equal(det.status, "no-notion");
});

test("detect: search lista, GET busca schema → candidata única (one)", async () => {
  await seedNotion("friend:x");
  const det = await detectTaskTracker("friend:x", {
    fetchImpl: routeFetch((url) => {
      if (url.includes("/v1/search")) {
        return {
          results: [
            { id: "ds1", object: "data_source", title: [{ plain_text: "Tarefas" }] },
            { id: "ds2", object: "data_source", title: [{ plain_text: "Notas" }] },
          ],
        };
      }
      if (url.includes("/v1/data_sources/ds1")) {
        return { id: "ds1", title: [{ plain_text: "Tarefas" }], properties: { Nome: { type: "title" } } };
      }
      if (url.includes("/v1/data_sources/ds2")) {
        return { id: "ds2", title: [{ plain_text: "Notas" }], properties: { Nome: { type: "title" } } };
      }
      return {};
    }),
  });
  assert.equal(det.status, "one");
  assert.deepEqual(det.candidates, [{ id: "ds1", title: "Tarefas" }]);
});

test("detect: nome neutro mas status+date no schema → candidata", async () => {
  await seedNotion("friend:x");
  const det = await detectTaskTracker("friend:x", {
    fetchImpl: routeFetch((url) => {
      if (url.includes("/v1/search")) {
        return { results: [{ id: "p1", object: "data_source", title: [{ plain_text: "Projetos" }] }] };
      }
      if (url.includes("/v1/data_sources/p1")) {
        return {
          id: "p1",
          title: [{ plain_text: "Projetos" }],
          properties: {
            Nome: { type: "title" },
            Status: { type: "select", select: { options: [{ name: "Feito" }] } },
            Quando: { type: "date" },
          },
        };
      }
      return {};
    }),
  });
  assert.equal(det.status, "one");
  assert.equal(det.candidates[0].id, "p1");
});

test("get/set tasks_db_id via vault", async () => {
  assert.equal(await getTasksDbId("friend:x"), null);
  await setTasksDbId("friend:x", "ds-99");
  assert.equal(await getTasksDbId("friend:x"), "ds-99");
});

test("useExistingTracker grava o id escolhido", async () => {
  await useExistingTracker("friend:x", "ds-chosen");
  assert.equal(await getTasksDbId("friend:x"), "ds-chosen");
});

test("createTaskTracker: cria página + DB, grava o data_source id", async () => {
  await seedNotion("friend:x");
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    let body: any = {};
    if (u.includes("/v1/pages")) body = { id: "page-1" };
    else if (u.includes("/v1/databases")) body = { id: "db-1", data_sources: [{ id: "ds-new" }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as any;

  const res = await createTaskTracker("friend:x", { fetchImpl });
  assert.equal(res.dataSourceId, "ds-new");
  assert.equal(await getTasksDbId("friend:x"), "ds-new");
  assert.ok(calls.some((c) => c.includes("/v1/pages")));
  assert.ok(calls.some((c) => c.includes("/v1/databases")));
});

test("createTaskTracker: reusa 'Tarefas' existente, sem criar página duplicada", async () => {
  await seedNotion("friend:y");
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    let body: any = {};
    if (u.includes("/v1/search")) {
      body = { results: [{ id: "ds-existing", object: "data_source", title: [{ plain_text: "Tarefas" }] }] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as any;

  const res = await createTaskTracker("friend:y", { fetchImpl });
  assert.equal(res.dataSourceId, "ds-existing");
  assert.equal(res.created, false);
  assert.equal(await getTasksDbId("friend:y"), "ds-existing");
  assert.ok(!calls.some((c) => c.includes("/v1/pages")), "não deve criar página-mãe nova");
  assert.ok(!calls.some((c) => c.includes("/v1/databases")), "não deve criar DB nova");
});

test("createTaskTracker sem Notion → erro claro", async () => {
  await assert.rejects(
    () => createTaskTracker("friend:no-notion", { fetchImpl: routeFetch(() => ({})) }),
    /conecte o Notion/i,
  );
});
