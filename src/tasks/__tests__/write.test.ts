// src/tasks/__tests__/write.test.ts
// 003-tasks-v1 — create/update payload builders across the reference schemas
// (done → concluida_em, cobrar prefix, select fallback pt, status-type error,
// origem na nota) + updateTask isolation (página de outro data source = 404)
// e o retry-on-400 do createTask.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildTrackerProfile, __clearTrackerProfileCache, TaskNotFoundError } from "../adapter.js";
import {
  buildCreatePagePayload,
  buildUpdatePagePayload,
  createTask,
  updateTask,
} from "../write.js";
import {
  SCHEMA_STANDARD_NEW,
  SCHEMA_STANDARD_OLD,
  SCHEMA_OWNER,
  SCHEMA_TITLE_ONLY,
  fakeFetch,
} from "./fixtures.js";

beforeEach(() => __clearTrackerProfileCache());

const TODAY = "2026-06-10";
const newProfile = () => buildTrackerProfile(SCHEMA_STANDARD_NEW as any);
const oldProfile = () => buildTrackerProfile(SCHEMA_STANDARD_OLD as any);
const ownerProfile = () => buildTrackerProfile(SCHEMA_OWNER as any);
const minProfile = () => buildTrackerProfile(SCHEMA_TITLE_ONLY as any);

// --- buildCreatePagePayload ---------------------------------------------------------

test("create payload: padrão novo com todos os campos canônicos", () => {
  const p = buildCreatePagePayload(
    newProfile(),
    {
      title: "Pagar fornecedor",
      status: "todo",
      prioridade: "alta",
      prazo: "2026-06-12T14:00:00-03:00",
      prazo_fim: "2026-06-12T15:00:00-03:00",
      tempo_estimado_min: 45,
      tipo: "cobrar",
      quem: "João",
      origem_url: "https://granola.ai/m/9",
      projeto: "Financeiro",
      note: "detalhe",
    },
    TODAY,
  ) as any;
  assert.deepEqual(p.parent, { type: "data_source_id", data_source_id: "ds-new" });
  assert.equal(p.properties.Nome.title[0].text.content, "Pagar fornecedor"); // tem prop tipo → SEM prefixo
  assert.deepEqual(p.properties.Status, { select: { name: "A fazer" } });
  assert.deepEqual(p.properties.Prioridade, { select: { name: "Alta" } });
  assert.deepEqual(p.properties.Prazo, {
    date: { start: "2026-06-12T14:00:00-03:00", end: "2026-06-12T15:00:00-03:00" },
  });
  assert.deepEqual(p.properties["Tempo estimado (min)"], { number: 45 });
  assert.deepEqual(p.properties.Tipo, { select: { name: "Cobrar" } });
  assert.equal(p.properties.Quem.rich_text[0].text.content, "João");
  assert.deepEqual(p.properties.Origem, { url: "https://granola.ai/m/9" });
  assert.deepEqual(p.properties.Projeto, { select: { name: "Financeiro" } });
  assert.equal(p.children[0].paragraph.rich_text[0].text.content, "detalhe");
});

test("create payload: status done seta Concluída em = hoje (quando o campo existe)", () => {
  const p = buildCreatePagePayload(newProfile(), { title: "X", status: "done" }, TODAY) as any;
  assert.deepEqual(p.properties.Status, { select: { name: "Concluída" } });
  assert.deepEqual(p.properties["Concluída em"], { date: { start: TODAY } });
});

test("create payload: owner status-type → opção real; done SEM concluida_em (não mapeado)", () => {
  const p = buildCreatePagePayload(ownerProfile(), { title: "X", status: "done" }, TODAY) as any;
  assert.deepEqual(p.properties.Status, { status: { name: "Done" } });
  assert.equal(Object.keys(p.properties).length, 2); // Task + Status
});

test("create payload: owner — prioridade canônica mapeia pra opção real (urgente→Ultra)", () => {
  const p = buildCreatePagePayload(
    ownerProfile(),
    { title: "X", prioridade: "urgente", projeto: "Zinom" },
    TODAY,
  ) as any;
  assert.deepEqual(p.properties.Priority, { select: { name: "Ultra" } });
  assert.deepEqual(p.properties.Projeto, { multi_select: [{ name: "Zinom" }] }); // multi_select
});

test("create payload: status canônico sem opção em base select → escreve o nome pt (Notion cria)", () => {
  const p = buildCreatePagePayload(oldProfile(), { title: "X", status: "blocked" }, TODAY) as any;
  assert.deepEqual(p.properties.Status, { select: { name: "Bloqueada" } });
});

test("create payload: status canônico sem opção em base status-type → erro claro", () => {
  const profile = buildTrackerProfile({
    id: "s",
    title: [{ plain_text: "Board" }],
    properties: {
      Nome: { type: "title", title: {} },
      Status: { type: "status", status: { options: [{ name: "Not started" }, { name: "Done" }] } },
    },
  } as any);
  assert.throws(
    () => buildCreatePagePayload(profile, { title: "X", status: "blocked" }, TODAY),
    /opções disponíveis/,
  );
});

test("create payload: tipo cobrar SEM prop tipo → prefixo 'Cobrar: ' no título", () => {
  const p = buildCreatePagePayload(oldProfile(), { title: "contrato do João", tipo: "cobrar" }, TODAY) as any;
  assert.equal(p.properties.Nome.title[0].text.content, "Cobrar: contrato do João");
});

test("create payload: origem_url SEM prop origem → primeira linha da nota", () => {
  const p = buildCreatePagePayload(
    oldProfile(),
    { title: "X", origem_url: "https://g.ai/m/1", note: "contexto" },
    TODAY,
  ) as any;
  assert.equal(p.properties.Origem, undefined);
  assert.equal(p.children[0].paragraph.rich_text[0].text.content, "https://g.ai/m/1\ncontexto");
});

test("create payload: base title-only grava só o título (graceful)", () => {
  const p = buildCreatePagePayload(
    minProfile(),
    { title: "Só isso", status: "todo", prioridade: "alta", tempo_estimado_min: 30, quem: "Ana", projeto: "P" },
    TODAY,
  ) as any;
  assert.deepEqual(Object.keys(p.properties), ["Nome"]);
});

// --- buildUpdatePagePayload ------------------------------------------------------------

test("update payload: só os campos passados; done → Concluída em hoje", () => {
  const props = buildUpdatePagePayload(newProfile(), { status: "done" }, TODAY) as any;
  assert.deepEqual(Object.keys(props).sort(), ["Concluída em", "Status"]);
  assert.deepEqual(props.Status, { select: { name: "Concluída" } });
  assert.deepEqual(props["Concluída em"], { date: { start: TODAY } });
});

test("update payload: titulo/prazo/tempo/quem; prazo vazio limpa a data", () => {
  const props = buildUpdatePagePayload(
    newProfile(),
    { titulo: "Novo nome", prazo: "2026-07-01", prazo_fim: "2026-07-02", tempo_estimado_min: 15, quem: "Bia" },
    TODAY,
  ) as any;
  assert.equal(props.Nome.title[0].text.content, "Novo nome");
  assert.deepEqual(props.Prazo, { date: { start: "2026-07-01", end: "2026-07-02" } });
  assert.deepEqual(props["Tempo estimado (min)"], { number: 15 });
  assert.equal(props.Quem.rich_text[0].text.content, "Bia");

  const clear = buildUpdatePagePayload(newProfile(), { prazo: "" }, TODAY) as any;
  assert.deepEqual(clear.Prazo, { date: null });
});

// --- createTask (rede falsa: retry-on-400) ------------------------------------------------

function writeDeps(schema: any, onCreate: (attempt: number, body: any) => { status?: number; body?: unknown }) {
  let schemaGets = 0;
  let creates = 0;
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) {
        schemaGets += 1;
        return { body: schema };
      }
      if (init?.method === "POST" && url.endsWith("/v1/pages")) {
        creates += 1;
        return onCreate(creates, JSON.parse(init.body));
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => schema.id,
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  return { deps, counts: () => ({ schemaGets, creates }) };
}

test("createTask: cria a página e devolve pageId/url/dataSourceId", async () => {
  const { deps } = writeDeps(SCHEMA_STANDARD_NEW, () => ({
    body: { id: "page-9", url: "https://notion.so/page-9" },
  }));
  const r = await createTask("friend:w1", { title: "Nova" }, deps);
  assert.equal(r.pageId, "page-9");
  assert.equal(r.url, "https://notion.so/page-9");
  assert.equal(r.dataSourceId, "ds-new");
  assert.equal(r.created, false);
});

test("createTask: 400 → invalida profile, recarrega e tenta exatamente 1x", async () => {
  const { deps, counts } = writeDeps(SCHEMA_STANDARD_NEW, (attempt) =>
    attempt === 1 ? { status: 400, body: { code: "validation_error", message: "property X" } } : { body: { id: "p2" } },
  );
  const r = await createTask("friend:w2", { title: "Retry" }, deps);
  assert.equal(r.pageId, "p2");
  assert.deepEqual(counts(), { schemaGets: 2, creates: 2 });
});

test("createTask: título vazio → erro antes de qualquer rede", async () => {
  const { deps, counts } = writeDeps(SCHEMA_STANDARD_NEW, () => ({ body: { id: "x" } }));
  await assert.rejects(createTask("friend:w3", { title: "  " }, deps), /título obrigatório/);
  assert.deepEqual(counts(), { schemaGets: 0, creates: 0 });
});

// --- updateTask -------------------------------------------------------------------------------

function updateDeps(opts: {
  parentDs: string;
  onPatch?: (body: any) => { status?: number; body?: unknown };
  pageProps?: any;
}) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      calls.push({ method: init?.method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_STANDARD_NEW };
      if (init?.method === "GET" && url.includes("/v1/pages/")) {
        return {
          body: {
            id: "page-1",
            parent: { type: "data_source_id", data_source_id: opts.parentDs },
            properties: opts.pageProps ?? { Nome: { type: "title", title: [{ plain_text: "T" }] } },
          },
        };
      }
      if (init?.method === "PATCH" && url.includes("/v1/pages/")) {
        return (
          opts.onPatch?.(JSON.parse(init.body)) ?? {
            body: {
              id: "page-1",
              url: "https://notion.so/page-1",
              parent: { type: "data_source_id", data_source_id: opts.parentDs },
              properties: {
                Nome: { type: "title", title: [{ plain_text: "T" }] },
                Status: { type: "select", select: { name: "Concluída" } },
              },
            },
          }
        );
      }
      if (init?.method === "PATCH" && url.includes("/children")) return { body: { results: [] } };
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-new",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  return { deps, calls };
}

test("updateTask: página de OUTRO data source → TaskNotFoundError, nada é escrito", async () => {
  const { deps, calls } = updateDeps({ parentDs: "outra-base-qualquer" });
  await assert.rejects(updateTask("friend:u1", "page-1", { status: "done" }, deps), TaskNotFoundError);
  assert.ok(!calls.some((c) => c.method === "PATCH"), "não pode haver PATCH");
});

test("updateTask: parent confere (ids normalizados com/sem hífen) → PATCH e Task canônica", async () => {
  // page parent vem SEM hífens; profile.dataSourceId é "ds-new" — usa ids reais:
  const { deps, calls } = updateDeps({ parentDs: "DS-NEW" });
  const t = await updateTask("friend:u2", "page-1", { status: "done" }, deps);
  const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/v1/pages/"));
  assert.ok(patch, "PATCH aconteceu");
  assert.deepEqual(patch!.body.properties.Status, { select: { name: "Concluída" } });
  assert.ok(patch!.body.properties["Concluída em"], "done seta concluída em");
  assert.equal(t.status, "done"); // resposta convertida pro canônico
});

test("updateTask: nota_append appenda parágrafo via blocks/children", async () => {
  const { deps, calls } = updateDeps({ parentDs: "ds-new" });
  await updateTask("friend:u3", "page-1", { nota_append: "Cobrei a Maria hoje" }, deps);
  const append = calls.find((c) => c.method === "PATCH" && c.url.includes("/children"));
  assert.ok(append, "children PATCH aconteceu");
  assert.equal(
    append!.body.children[0].paragraph.rich_text[0].text.content,
    "Cobrei a Maria hoje",
  );
  // sem campos de properties → nenhum PATCH de página
  assert.ok(!calls.some((c) => c.method === "PATCH" && /\/v1\/pages\//.test(c.url)));
});

test("updateTask: página inexistente (GET falha) → TaskNotFoundError", async () => {
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_STANDARD_NEW };
      if (init?.method === "GET" && url.includes("/v1/pages/")) return { status: 404, body: {} };
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-new",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  await assert.rejects(updateTask("friend:u4", "page-x", { status: "done" }, deps), TaskNotFoundError);
});
