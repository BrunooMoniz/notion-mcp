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
  searchParentPages,
  findWorkspaceForPage,
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

test("createTaskTracker: criação NOVA invalida o profile cacheado da conta", async () => {
  await seedNotion("friend:inv");
  const { loadTrackerProfile, __clearTrackerProfileCache } = await import("../../tasks/adapter.js");
  __clearTrackerProfileCache();

  // Pré-aquece o cache do adapter com uma base antiga.
  let schemaGets = 0;
  const profileDeps = {
    fetchImpl: (async (url: string, init?: any) => {
      if (init?.method === "GET" && String(url).includes("/v1/data_sources/")) schemaGets += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ title: [{ plain_text: "Velha" }], properties: { Nome: { type: "title", title: {} } } }),
      };
    }) as any,
    getTasksDbIdImpl: async () => "ds-velha",
    resolveTokensImpl: async () => [{ workspace: "ws-1", token: "t" }],
  };
  await loadTrackerProfile("friend:inv", profileDeps);
  await loadTrackerProfile("friend:inv", profileDeps);
  assert.equal(schemaGets, 1, "cache quente");

  // Cria uma base NOVA (sem reuse) → o cache precisa cair.
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    let body: any = {};
    if (u.includes("/v1/pages")) body = { id: "page-1" };
    else if (u.includes("/v1/databases")) body = { id: "db-1", data_sources: [{ id: "ds-nova" }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as any;
  await createTaskTracker("friend:inv", { fetchImpl });

  await loadTrackerProfile("friend:inv", profileDeps);
  assert.equal(schemaGets, 2, "profile recarregado após o write de tasks_db");
});

test("createTaskTracker sem Notion → erro claro", async () => {
  await assert.rejects(
    () => createTaskTracker("friend:no-notion", { fetchImpl: routeFetch(() => ({})) }),
    /conecte o Notion/i,
  );
});

test("create: parentPageId explícito → DB sob a página, sem 🧠 Zinom e sem reuse-guard", async () => {
  await seedNotion("friend:x");
  const calls: Array<{ url: string; body: any }> = [];
  const r = await createTaskTracker("friend:x", {
    parentPageId: "0123456789abcdef0123456789abcdef",
    fetchImpl: routeFetch((url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).includes("/v1/databases")) return { id: "db-1", data_sources: [{ id: "ds-1" }] };
      return {};
    }),
  });
  assert.equal(r.dataSourceId, "ds-1");
  assert.equal(r.created, true);
  assert.ok(!calls.some((c) => c.url.includes("/v1/search")), "sem reuse-guard com alvo explícito");
  assert.ok(!calls.some((c) => c.url.includes("/v1/pages")), "sem página-mãe com alvo explícito");
  const db = calls.find((c) => c.url.includes("/v1/databases"));
  assert.equal(db!.body.parent.page_id, "0123456789abcdef0123456789abcdef");
  assert.equal(await getTasksDbId("friend:x"), "ds-1");
});

test("create: workspace preferido usa o token DESSE workspace", async () => {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret("friend:x", "notion_pat:ws-1", "ntn_um");
  await setAccountSecret("friend:x", "notion_pat:ws-2", "ntn_dois");
  workspaces = ["ws-1", "ws-2"];
  let auth = "";
  await createTaskTracker("friend:x", {
    workspace: "ws-2",
    parentPageId: "0123456789abcdef0123456789abcdef",
    fetchImpl: routeFetch((url, init) => {
      if (String(url).includes("/v1/databases")) {
        auth = init?.headers?.Authorization ?? "";
        return { id: "db-1", data_sources: [{ id: "ds-2" }] };
      }
      return {};
    }),
  });
  assert.equal(auth, "Bearer ntn_dois");
});

test("create: workspace preferido sem token → erro claro", async () => {
  await seedNotion("friend:x"); // só ws-1
  await assert.rejects(
    () => createTaskTracker("friend:x", { workspace: "ws-9", fetchImpl: routeFetch(() => ({})) }),
    /ws-9/,
  );
});

test("searchParentPages: agrega páginas por workspace com título e url", async () => {
  await seedNotion("friend:x");
  const pages = await searchParentPages("friend:x", "Projetos", {
    fetchImpl: routeFetch((url) => {
      if (String(url).includes("/v1/search")) {
        return { results: [{ id: "p-1", url: "https://notion.so/p1", properties: { Nome: { type: "title", title: [{ plain_text: "Projetos 2026" }] } } }] };
      }
      return {};
    }),
  });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], { id: "p-1", title: "Projetos 2026", url: "https://notion.so/p1", workspace: "ws-1" });
});

test("findWorkspaceForPage: primeiro token que lê a página ganha", async () => {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret("friend:x", "notion_pat:ws-1", "ntn_um");
  await setAccountSecret("friend:x", "notion_pat:ws-2", "ntn_dois");
  workspaces = ["ws-1", "ws-2"];
  const hit = await findWorkspaceForPage("friend:x", "0123456789abcdef0123456789abcdef", {
    fetchImpl: (async (url: string, init: any) => {
      const okToken = init?.headers?.Authorization === "Bearer ntn_dois";
      return {
        ok: okToken, status: okToken ? 200 : 404,
        text: async () => JSON.stringify(okToken
          ? { id: "0123...", url: "https://notion.so/x", properties: { title: { type: "title", title: [{ plain_text: "Casa" }] } } }
          : { code: "object_not_found" }),
      };
    }) as any,
  });
  assert.equal(hit?.workspace, "ws-2");
  assert.equal(hit?.title, "Casa");
});

test("owner: resolve tokens do .env (DEFAULT_ACCOUNT_ID)", async () => {
  process.env.NOTION_PERSONAL_TOKEN = "ntn_env_personal";
  try {
    let auth = "";
    await createTaskTracker("bruno", {
      workspace: "personal",
      parentPageId: "0123456789abcdef0123456789abcdef",
      fetchImpl: routeFetch((url, init) => {
        if (String(url).includes("/v1/databases")) {
          auth = init?.headers?.Authorization ?? "";
          return { id: "db-1", data_sources: [{ id: "ds-o" }] };
        }
        return {};
      }),
    });
    assert.equal(auth, "Bearer ntn_env_personal");
  } finally { delete process.env.NOTION_PERSONAL_TOKEN; }
});
