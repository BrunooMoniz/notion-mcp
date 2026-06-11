// src/tasks/__tests__/read.test.ts
// 003-tasks-v1 — listTasks: query builders, page→Task conversion across the
// reference schemas, sort, board summary and the invalidate-retry on 400.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildTrackerProfile, __clearTrackerProfileCache } from "../adapter.js";
import {
  buildListQuery,
  pageToTask,
  applyClientFilters,
  sortTasks,
  summarizeBoard,
  listTasks,
} from "../read.js";
import type { Task } from "../model.js";
import {
  SCHEMA_STANDARD_NEW,
  SCHEMA_STANDARD_OLD,
  SCHEMA_OWNER,
  SCHEMA_TITLE_ONLY,
  fakeFetch,
} from "./fixtures.js";

beforeEach(() => __clearTrackerProfileCache());

const newProfile = () => buildTrackerProfile(SCHEMA_STANDARD_NEW as any);
const oldProfile = () => buildTrackerProfile(SCHEMA_STANDARD_OLD as any);
const ownerProfile = () => buildTrackerProfile(SCHEMA_OWNER as any);
const minProfile = () => buildTrackerProfile(SCHEMA_TITLE_ONLY as any);

// --- buildListQuery ---------------------------------------------------------------

test("buildListQuery: default exclui done/canceled mapeados (select, padrão novo)", () => {
  const q = buildListQuery(newProfile(), {}) as any;
  assert.deepEqual(q.filter, {
    and: [
      { property: "Status", select: { does_not_equal: "Concluída" } },
      { property: "Status", select: { does_not_equal: "Cancelada" } },
    ],
  });
  assert.equal(q.page_size, 25);
  assert.deepEqual(q.sorts, [{ property: "Prazo", direction: "ascending" }]);
});

test("buildListQuery: padrão antigo só tem Feito como fechado → um does_not_equal", () => {
  const q = buildListQuery(oldProfile(), {}) as any;
  assert.deepEqual(q.filter, { property: "Status", select: { does_not_equal: "Feito" } });
});

test("buildListQuery: owner usa filtros do tipo status (não select)", () => {
  const q = buildListQuery(ownerProfile(), {}) as any;
  // ordem segue a ordem das opções no schema (Canceled vem antes de Done)
  assert.deepEqual(q.filter, {
    and: [
      { property: "Status", status: { does_not_equal: "Canceled" } },
      { property: "Status", status: { does_not_equal: "Done" } },
    ],
  });
});

test("buildListQuery: filtro de status canônico vira OR de equals nas opções reais", () => {
  const q = buildListQuery(ownerProfile(), { status: ["todo", "in_progress"] }) as any;
  assert.deepEqual(q.filter, {
    or: [
      { property: "Status", status: { equals: "To-do" } },
      { property: "Status", status: { equals: "In progress" } },
    ],
  });
});

test("buildListQuery: prazo_de/ate + q + limit", () => {
  const q = buildListQuery(newProfile(), {
    prazo_de: "2026-06-01",
    prazo_ate: "2026-06-30",
    q: "fatura",
    limit: 250,
  }) as any;
  assert.equal(q.page_size, 100, "limit cap 100");
  const and = q.filter.and as any[];
  assert.ok(and.some((f) => f.date?.on_or_after === "2026-06-01" && f.property === "Prazo"));
  assert.ok(and.some((f) => f.date?.on_or_before === "2026-06-30" && f.property === "Prazo"));
  assert.ok(and.some((f) => f.title?.contains === "fatura" && f.property === "Nome"));
});

test("buildListQuery: base title-only não filtra nem ordena (sem props)", () => {
  const q = buildListQuery(minProfile(), {}) as any;
  assert.equal(q.filter, undefined);
  assert.equal(q.sorts, undefined);
});

// --- pageToTask ---------------------------------------------------------------------

function ownerPage() {
  return {
    id: "page-1",
    url: "https://notion.so/page-1",
    properties: {
      Task: { type: "title", title: [{ plain_text: "Fechar relatório" }] },
      Status: { type: "status", status: { name: "In progress" } },
      Priority: { type: "select", select: { name: "Ultra" } },
      "Due date": { type: "date", date: { start: "2026-06-12" } },
      "Tempo estimado": { type: "number", number: 90 },
      Projeto: { type: "multi_select", multi_select: [{ name: "Zinom" }, { name: "Nora" }] },
    },
  };
}

test("pageToTask: owner → canônico (status/prioridade) + projeto multi_select join", () => {
  const t = pageToTask(ownerProfile(), ownerPage());
  assert.equal(t.title, "Fechar relatório");
  assert.equal(t.status, "in_progress");
  assert.equal(t.prioridade, "urgente"); // Ultra → urgente
  assert.equal(t.prazo, "2026-06-12");
  assert.equal(t.tempo_estimado_min, 90);
  assert.equal(t.projeto, "Zinom, Nora");
});

test("pageToTask: padrão novo → tipo/quem/origem/concluida_em", () => {
  const page = {
    id: "p2",
    url: null,
    properties: {
      Nome: { type: "title", title: [{ plain_text: "Cobrar contrato" }] },
      Status: { type: "select", select: { name: "Concluída" } },
      Tipo: { type: "select", select: { name: "Cobrar" } },
      Quem: { type: "rich_text", rich_text: [{ plain_text: "Maria" }] },
      Origem: { type: "url", url: "https://granola.ai/m/1" },
      "Criada em": { type: "created_time", created_time: "2026-06-01T10:00:00Z" },
      "Concluída em": { type: "date", date: { start: "2026-06-09" } },
    },
  };
  const t = pageToTask(newProfile(), page);
  assert.equal(t.status, "done");
  assert.equal(t.tipo, "cobrar");
  assert.equal(t.quem, "Maria");
  assert.equal(t.origem_url, "https://granola.ai/m/1");
  assert.equal(t.criada_em, "2026-06-01T10:00:00Z");
  assert.equal(t.concluida_em, "2026-06-09");
});

test("pageToTask: opção passthrough mantém o nome literal", () => {
  const profile = buildTrackerProfile({
    id: "x",
    title: [{ plain_text: "Pipeline" }],
    properties: {
      Nome: { type: "title", title: {} },
      Status: { type: "select", select: { options: [{ name: "Em validação" }] } },
    },
  } as any);
  const t = pageToTask(profile, {
    id: "p",
    properties: {
      Nome: { type: "title", title: [{ plain_text: "X" }] },
      Status: { type: "select", select: { name: "Em validação" } },
    },
  });
  assert.equal(t.status, "Em validação");
});

test("pageToTask: title-only lista sem status (graceful)", () => {
  const t = pageToTask(minProfile(), {
    id: "p",
    properties: { Nome: { type: "title", title: [{ plain_text: "Só título" }] } },
  });
  assert.equal(t.title, "Só título");
  assert.equal(t.status, "");
});

// --- sort / filters / board ------------------------------------------------------------

const mk = (over: Partial<Task>): Task => ({
  id: "t",
  url: null,
  title: "x",
  status: "todo",
  ...over,
});

test("sortTasks: prazo asc, sem prazo no fim, empate decide por prioridade", () => {
  const sorted = sortTasks([
    mk({ id: "semprazo", prioridade: "urgente" }),
    mk({ id: "b", prazo: "2026-06-12", prioridade: "baixa" }),
    mk({ id: "a", prazo: "2026-06-12", prioridade: "urgente" }),
    mk({ id: "cedo", prazo: "2026-06-10", prioridade: "media" }),
  ]);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["cedo", "a", "b", "semprazo"],
  );
});

test("applyClientFilters: status pedido vale para canônico e literal", () => {
  const tasks = [
    mk({ id: "1", status: "todo" }),
    mk({ id: "2", status: "Em validação" }),
    mk({ id: "3", status: "done" }),
  ];
  assert.deepEqual(applyClientFilters(tasks, { status: ["todo"] }).map((t) => t.id), ["1"]);
  assert.deepEqual(
    applyClientFilters(tasks, { status: ["em validação"] }).map((t) => t.id),
    ["2"],
  );
  // default: fechadas ficam de fora
  assert.deepEqual(applyClientFilters(tasks, {}).map((t) => t.id), ["1", "2"]);
  assert.equal(applyClientFilters(tasks, { incluir_concluidas: true }).length, 3);
});

test("summarizeBoard: contagem por status, estimado dos abertos, overdue", () => {
  const board = summarizeBoard(
    [
      mk({ status: "todo", tempo_estimado_min: 30, prazo: "2026-06-01" }), // overdue
      mk({ status: "in_progress", tempo_estimado_min: 60 }),
      mk({ status: "done", tempo_estimado_min: 999, concluida_em: "2026-06-05" }),
    ],
    "2026-06-10",
  );
  assert.deepEqual(board.by_status, { todo: 1, in_progress: 1, done: 1 });
  assert.equal(board.abertos, 2);
  assert.equal(board.estimado_min, 90); // done não conta
  assert.equal(board.overdue_count, 1);
});

// --- listTasks (rede falsa) ----------------------------------------------------------

test("listTasks: consulta o data source, converte, ordena e resume o board", async () => {
  const pages = [ownerPage(), { ...ownerPage(), id: "page-2", properties: { ...ownerPage().properties, Status: { type: "status", status: { name: "Done" } } } }];
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_OWNER };
      if (init?.method === "POST" && url.includes("/query")) return { body: { results: pages } };
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-owner",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  const r = await listTasks("friend:list1", {}, deps);
  // default exclui a Done (client-side também)
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].status, "in_progress");
  assert.equal(r.board.abertos, 1);
  assert.equal(r.tracker_url, null); // SCHEMA_OWNER não tem parent/url
});

test("listTasks: 400 na query → invalida o profile, recarrega e tenta 1x", async () => {
  let schemaGets = 0;
  let queries = 0;
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) {
        schemaGets += 1;
        return { body: SCHEMA_STANDARD_NEW };
      }
      if (init?.method === "POST" && url.includes("/query")) {
        queries += 1;
        if (queries === 1) return { status: 400, body: { code: "validation_error" } };
        return { body: { results: [] } };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-new",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  const r = await listTasks("friend:list2", {}, deps);
  assert.equal(queries, 2, "retry após o 400");
  assert.equal(schemaGets, 2, "profile recarregado após invalidate");
  assert.deepEqual(r.tasks, []);
});

test("listTasks: erro não-400 propaga (sem retry infinito)", async () => {
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_STANDARD_NEW };
      if (init?.method === "POST" && url.includes("/query")) return { status: 500, body: { message: "boom" } };
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-new",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  await assert.rejects(listTasks("friend:list3", {}, deps), /HTTP 500/);
});
