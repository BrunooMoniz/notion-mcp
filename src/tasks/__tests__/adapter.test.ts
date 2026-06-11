// src/tasks/__tests__/adapter.test.ts
// 003-tasks-v1 — table-driven adapter tests over the 4 reference schemas, plus
// loadTrackerProfile resolution/cache/invalidate semantics (deps injected, no
// network, no DB).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildTrackerProfile,
  resolveStatusOptionName,
  loadTrackerProfile,
  invalidateTrackerProfile,
  __clearTrackerProfileCache,
  getTasksInfo,
  NoTrackerError,
  NoNotionError,
  OWNER_TASKS_DS_FALLBACK,
} from "../adapter.js";
import {
  SCHEMA_STANDARD_NEW,
  SCHEMA_STANDARD_OLD,
  SCHEMA_OWNER,
  SCHEMA_TITLE_ONLY,
  fakeFetch,
} from "./fixtures.js";

beforeEach(() => __clearTrackerProfileCache());

// --- buildTrackerProfile (pure, table-driven) ---------------------------------

const cases = [
  {
    name: "padrão novo",
    schema: SCHEMA_STANDARD_NEW,
    title: "Tarefas",
    titleProp: "Nome",
    statusKind: "select" as const,
    statusMap: {
      backlog: "Backlog",
      todo: "A fazer",
      in_progress: "Em andamento",
      blocked: "Bloqueada",
      done: "Concluída",
      canceled: "Cancelada",
    },
    mappedNames: {
      prioridade: "Prioridade",
      prazo: "Prazo",
      tempo: "Tempo estimado (min)",
      tipo: "Tipo",
      quem: "Quem",
      origem: "Origem",
      projeto: "Projeto",
      criada_em: "Criada em",
      concluida_em: "Concluída em",
    },
    missing: [],
  },
  {
    name: "padrão antigo (select A fazer/Fazendo/Feito)",
    schema: SCHEMA_STANDARD_OLD,
    title: "Tarefas",
    titleProp: "Nome",
    statusKind: "select" as const,
    statusMap: { todo: "A fazer", in_progress: "Fazendo", done: "Feito" },
    mappedNames: { prazo: "Prazo", tempo: "Tempo estimado", projeto: "Frente" },
    missing: ["prioridade", "tipo", "quem", "origem", "criada_em", "concluida_em"],
  },
  {
    name: "owner (status-type inglês, Priority Ultra/High, Projeto multi_select)",
    schema: SCHEMA_OWNER,
    title: "Tasks Tracker",
    titleProp: "Task",
    statusKind: "status" as const,
    statusMap: {
      backlog: "Backlog",
      todo: "To-do",
      in_progress: "In progress",
      blocked: "Blocked",
      done: "Done",
      canceled: "Canceled",
    },
    mappedNames: {
      prioridade: "Priority",
      prazo: "Due date",
      tempo: "Tempo estimado",
      projeto: "Projeto",
    },
    missing: ["tipo", "quem", "origem", "criada_em", "concluida_em"],
  },
  {
    name: "title-only",
    schema: SCHEMA_TITLE_ONLY,
    title: "Minhas Tarefas",
    titleProp: "Nome",
    statusKind: null,
    statusMap: {},
    mappedNames: {},
    missing: [
      "status",
      "prioridade",
      "prazo",
      "tempo",
      "tipo",
      "quem",
      "origem",
      "projeto",
      "criada_em",
      "concluida_em",
    ],
  },
];

for (const c of cases) {
  test(`buildTrackerProfile: ${c.name}`, () => {
    const p = buildTrackerProfile(c.schema as any);
    assert.equal(p.title, c.title);
    assert.equal(p.props.title, c.titleProp);

    if (c.statusKind === null) {
      assert.equal(p.props.status, undefined);
    } else {
      assert.equal(p.props.status!.kind, c.statusKind);
      for (const [canon, real] of Object.entries(c.statusMap)) {
        assert.equal((p.props.status!.map as Record<string, string>)[canon], real, `status ${canon}`);
      }
    }
    for (const [field, name] of Object.entries(c.mappedNames)) {
      const got = (p.props as any)[field];
      assert.ok(got, `campo ${field} deveria estar mapeado`);
      assert.equal(got.name, name, `campo ${field}`);
    }
    assert.deepEqual([...p.missing].sort(), [...c.missing].sort());
  });
}

test("buildTrackerProfile: owner — kinds (multi_select projeto) e reverse de prioridade", () => {
  const p = buildTrackerProfile(SCHEMA_OWNER as any);
  assert.equal(p.props.projeto!.kind, "multi_select");
  assert.equal(p.props.prioridade!.reverse["ultra"], "urgente");
  assert.equal(p.props.prioridade!.reverse["high"], "alta");
  // status reverse: opções reais → canônico
  assert.equal(p.props.status!.reverse["to-do"], "todo");
  assert.equal(p.props.status!.reverse["in progress"], "in_progress");
});

test("buildTrackerProfile: url derivada do database parent quando o ds não traz url", () => {
  const p = buildTrackerProfile(SCHEMA_STANDARD_NEW as any);
  assert.equal(p.url, "https://www.notion.so/11112222333344445555666677778888");
  const noParent = buildTrackerProfile(SCHEMA_TITLE_ONLY as any);
  assert.equal(noParent.url, null);
});

test("buildTrackerProfile: opção sem sinônimo fica passthrough (sem canônico)", () => {
  const schema = {
    id: "ds-x",
    title: [{ plain_text: "Pipeline" }],
    properties: {
      Nome: { type: "title", title: {} },
      Status: {
        type: "select",
        select: { options: [{ id: "1", name: "A fazer" }, { id: "2", name: "Em validação" }] },
      },
    },
  };
  const p = buildTrackerProfile(schema as any);
  assert.equal(p.props.status!.reverse["em validacao"], undefined); // sem canônico
  assert.ok(p.props.status!.options.includes("Em validação")); // mas acessível por nome
});

// --- resolveStatusOptionName -----------------------------------------------------

test("resolveStatusOptionName: canônico → opção real; sinônimo também resolve", () => {
  const p = buildTrackerProfile(SCHEMA_OWNER as any);
  assert.equal(resolveStatusOptionName(p.props.status!, "todo"), "To-do");
  assert.equal(resolveStatusOptionName(p.props.status!, "A fazer"), "To-do"); // sinônimo de todo
  assert.equal(resolveStatusOptionName(p.props.status!, "done"), "Done");
});

test("resolveStatusOptionName: literal existente passa direto (case/acento-insensitive)", () => {
  const p = buildTrackerProfile(SCHEMA_STANDARD_NEW as any);
  assert.equal(resolveStatusOptionName(p.props.status!, "em andamento"), "Em andamento");
});

test("resolveStatusOptionName: select sem a opção → nome pt padrão (Notion cria)", () => {
  const p = buildTrackerProfile(SCHEMA_STANDARD_OLD as any);
  // a base antiga não tem opção para blocked → escreve o nome pt do template
  assert.equal(resolveStatusOptionName(p.props.status!, "blocked"), "Bloqueada");
});

test("resolveStatusOptionName: status-type sem a opção → erro listando as disponíveis", () => {
  const schema = {
    id: "ds-s",
    title: [{ plain_text: "Board" }],
    properties: {
      Nome: { type: "title", title: {} },
      Status: {
        type: "status",
        status: { options: [{ id: "1", name: "Not started" }, { id: "2", name: "Done" }] },
      },
    },
  };
  const p = buildTrackerProfile(schema as any);
  assert.throws(
    () => resolveStatusOptionName(p.props.status!, "blocked"),
    /opções disponíveis: Not started, Done/,
  );
});

// --- loadTrackerProfile: resolução + cache TTL + invalidate ------------------------

function depsFor(schema: any, opts: { dsId?: string | null; tokens?: Array<{ workspace: string; token: string }> } = {}) {
  let fetchCount = 0;
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) {
        fetchCount += 1;
        return { body: schema };
      }
      return { status: 500, body: {} };
    }),
    getTasksDbIdImpl: async () => (opts.dsId === undefined ? schema.id : opts.dsId),
    resolveTokensImpl: async () => opts.tokens ?? [{ workspace: "wsA", token: "tok-a" }],
  };
  return { deps, count: () => fetchCount };
}

test("loadTrackerProfile: friend sem tracker → NoTrackerError (nunca cria)", async () => {
  const { deps } = depsFor(SCHEMA_STANDARD_NEW, { dsId: null });
  await assert.rejects(loadTrackerProfile("friend:a", deps), NoTrackerError);
});

test("loadTrackerProfile: sem nenhum token Notion → NoNotionError", async () => {
  const { deps } = depsFor(SCHEMA_STANDARD_NEW, { tokens: [] });
  await assert.rejects(loadTrackerProfile("friend:b", deps), NoNotionError);
});

test("loadTrackerProfile: owner sem vault usa o fallback hardcoded (cron não quebra)", async () => {
  let askedUrl = "";
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) {
        askedUrl = url;
        return { body: { ...SCHEMA_OWNER, id: OWNER_TASKS_DS_FALLBACK } };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => null,
    resolveTokensImpl: async () => [{ workspace: "personal", token: "ntn_env" }],
  };
  const ctx = await loadTrackerProfile("bruno", deps);
  assert.ok(askedUrl.includes(OWNER_TASKS_DS_FALLBACK));
  assert.equal(ctx.profile.dataSourceId, OWNER_TASKS_DS_FALLBACK);
});

test("loadTrackerProfile: cache 5 min por conta + invalidateTrackerProfile força reload", async () => {
  const { deps, count } = depsFor(SCHEMA_STANDARD_NEW);
  await loadTrackerProfile("friend:c", deps);
  await loadTrackerProfile("friend:c", deps);
  assert.equal(count(), 1, "segunda chamada deve vir do cache");

  invalidateTrackerProfile("friend:c");
  await loadTrackerProfile("friend:c", deps);
  assert.equal(count(), 2, "invalidate força um novo GET");
});

test("loadTrackerProfile: cache expira após o TTL (5 min)", async () => {
  const { deps, count } = depsFor(SCHEMA_STANDARD_NEW);
  const t0 = new Date("2026-06-10T12:00:00Z");
  await loadTrackerProfile("friend:ttl", { ...deps, now: t0 });
  await loadTrackerProfile("friend:ttl", { ...deps, now: new Date(t0.getTime() + 4 * 60_000) });
  assert.equal(count(), 1, "dentro do TTL usa cache");
  await loadTrackerProfile("friend:ttl", { ...deps, now: new Date(t0.getTime() + 6 * 60_000) });
  assert.equal(count(), 2, "após o TTL recarrega");
});

test("loadTrackerProfile: tenta o próximo workspace quando o primeiro token não lê o ds", async () => {
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      const auth = init?.headers?.Authorization ?? "";
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) {
        if (auth.includes("tok-bad")) return { status: 404, body: { code: "object_not_found" } };
        return { body: SCHEMA_STANDARD_OLD };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-old",
    resolveTokensImpl: async () => [
      { workspace: "ws-bad", token: "tok-bad" },
      { workspace: "ws-good", token: "tok-good" },
    ],
  };
  const ctx = await loadTrackerProfile("friend:multi", deps);
  assert.equal(ctx.workspace, "ws-good");
  assert.equal(ctx.token, "tok-good");
});

// --- getTasksInfo -------------------------------------------------------------------

test("getTasksInfo: configurado → shape completo com mapped/missing/is_standard", async () => {
  const { deps } = depsFor(SCHEMA_STANDARD_OLD);
  const info = await getTasksInfo("friend:info1", deps);
  assert.equal(info.configured, true);
  assert.equal(info.title, "Tarefas");
  assert.equal(info.is_standard, true);
  assert.ok(info.mapped.includes("status"));
  assert.ok(info.mapped.includes("projeto")); // Frente → projeto por sinônimo
  assert.ok(info.missing.includes("prioridade"));
});

test("getTasksInfo: base própria (título ≠ Tarefas) → is_standard false", async () => {
  const { deps } = depsFor(SCHEMA_OWNER);
  const info = await getTasksInfo("friend:info2", deps);
  assert.equal(info.configured, true);
  assert.equal(info.is_standard, false);
});

test("getTasksInfo: sem tracker → configured false (sem erro)", async () => {
  const { deps } = depsFor(SCHEMA_STANDARD_NEW, { dsId: null });
  const info = await getTasksInfo("friend:info3", deps);
  assert.deepEqual(info, {
    configured: false,
    title: null,
    url: null,
    mapped: [],
    missing: [],
    is_standard: false,
  });
});
