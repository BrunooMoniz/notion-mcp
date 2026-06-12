// src/portal/__tests__/task-tracker-destino.test.ts
// 2026-06-12 tasks-onboarding-escolha-destino — escolha explícita de workspace:
// fingerprint do template Zinom (reuse-guard seguro) e WorkspaceRequiredError
// quando a conta tem mais de um Notion conectado.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);

import { isZinomStandardSchema } from "../task-tracker-schema.js";
import { detectTaskTracker, createTaskTracker, WorkspaceRequiredError } from "../task-tracker.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { __clearAccountTokenCache } from "../../account-tokens.js";

let store: Map<string, string>; // `${account}|${kind}` -> enc_value
let workspaces: string[];

// Pool mínimo: vault account_secrets + account_workspaces (mesmo seam de
// task-tracker.test.ts).
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

// --- Task 1.1: fingerprint do template Zinom --------------------------------

test("isZinomStandardSchema: template Zinom (Tipo Fazer/Cobrar + Tempo estimado (min)) → true", () => {
  assert.equal(isZinomStandardSchema({
    "Tempo estimado (min)": { type: "number" },
    Tipo: { type: "select", select: { options: [{ name: "Fazer" }, { name: "Cobrar" }] } },
  } as any), true);
});

test("isZinomStandardSchema: board scrum alheio chamado 'Tarefas' → false", () => {
  assert.equal(isZinomStandardSchema({
    "Story Points": { type: "number" },
    Tipo: { type: "select", select: { options: [{ name: "📁 Projetos" }, { name: "☑️ Tarefas" }] } },
  } as any), false);
});

// --- Task 1.2: workspace explícito obrigatório quando há >1 Notion ----------

test("detect sem workspace com >1 token → status workspace_required", async (t) => {
  process.env.NOTION_PERSONAL_TOKEN = "tok-a";
  process.env.NOTION_GLOBALCRIPTO_TOKEN = "tok-b";
  delete process.env.NOTION_NORA_TOKEN;
  t.after(() => { delete process.env.NOTION_PERSONAL_TOKEN; delete process.env.NOTION_GLOBALCRIPTO_TOKEN; });
  const r = await detectTaskTracker("bruno", { fetchImpl: (async () => { throw new Error("não deve chamar rede"); }) as any });
  assert.equal((r as any).status, "workspace_required");
  assert.deepEqual((r as any).workspaces, ["personal", "globalcripto"]);
});

test("WorkspaceRequiredError: contrato por name + workspaces", () => {
  const err = new WorkspaceRequiredError(["personal", "globalcripto"]);
  assert.equal(err.name, "WorkspaceRequiredError");
  assert.deepEqual(err.workspaces, ["personal", "globalcripto"]);
});

// --- Task 1.3: reuse-guard restrito ao template Zinom ------------------------

const ZINOM_SCHEMA = {
  Nome: { type: "title" },
  "Tempo estimado (min)": { type: "number" },
  Tipo: { type: "select", select: { options: [{ name: "Fazer" }, { name: "Cobrar" }] } },
};

const SCRUM_SCHEMA = {
  Nome: { type: "title" },
  "Story Points": { type: "number" },
  Tipo: { type: "select", select: { options: [{ name: "📁 Projetos" }, { name: "☑️ Tarefas" }] } },
};

async function seedNotion(accountId: string, ws = "ws-1") {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret(accountId, `notion_pat:${ws}`, "ntn_fake");
  workspaces = [ws];
}

test("create: base alheia chamada 'Tarefas' SEM fingerprint → cria nova em vez de adotar", async () => {
  await seedNotion("friend:guard");
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: any) => {
    const u = String(url);
    calls.push(`${init?.method ?? "POST"} ${u}`);
    let body: any = {};
    if (u.includes("/v1/search")) {
      body = { results: [{ id: "ds-alheia", object: "data_source", title: [{ plain_text: "Tarefas" }] }] };
    } else if (u.includes("/v1/data_sources/ds-alheia")) {
      body = { id: "ds-alheia", title: [{ plain_text: "Tarefas" }], properties: SCRUM_SCHEMA };
    } else if (u.includes("/v1/pages")) {
      body = { id: "page-1" };
    } else if (u.includes("/v1/databases")) {
      body = { id: "db-1", data_sources: [{ id: "ds-nova" }] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as any;

  const res = await createTaskTracker("friend:guard", { workspace: "ws-1", fetchImpl });
  assert.equal(res.dataSourceId, "ds-nova");
  assert.equal(res.created, true);
  assert.ok(calls.some((c) => c.includes("GET") && c.includes("/v1/data_sources/ds-alheia")), "inspecionou o schema da candidata");
  assert.ok(calls.some((c) => c.includes("/v1/pages")), "criou a página-mãe nova");
  assert.ok(calls.some((c) => c.includes("/v1/databases")), "criou a DB nova");
});

test("create sem workspace em conta friend com 2 Notion → lança WorkspaceRequiredError", async () => {
  const { setAccountSecret } = await import("../../secrets.js");
  await setAccountSecret("friend:multi", "notion_pat:ws-1", "ntn_um");
  await setAccountSecret("friend:multi", "notion_pat:ws-2", "ntn_dois");
  workspaces = ["ws-1", "ws-2"];
  await assert.rejects(
    () => createTaskTracker("friend:multi", { fetchImpl: (async () => { throw new Error("não deve chamar rede"); }) as any }),
    (err: any) => {
      assert.equal(err?.name, "WorkspaceRequiredError");
      assert.deepEqual(err?.workspaces, ["ws-1", "ws-2"]);
      return true;
    },
  );
});
