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
  // O scan é sempre na largura máxima (100): o board resume a base inteira e o
  // limit só fatia o retorno.
  assert.equal(q.page_size, 100);
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
  assert.equal(q.page_size, 100, "scan sempre a 100 por página");
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

test("pageToTask: campos de texto livres são limitados a 300 chars (hardening)", () => {
  const long = "x".repeat(1000);
  const page = {
    id: "p-long",
    properties: {
      Nome: { type: "title", title: [{ plain_text: long }] },
      Quem: { type: "rich_text", rich_text: [{ plain_text: long }] },
      Origem: { type: "url", url: `https://x.test/${long}` },
      Projeto: { type: "select", select: { name: long } },
    },
  };
  const t = pageToTask(newProfile(), page);
  assert.equal(t.title.length, 300);
  assert.equal(t.quem!.length, 300);
  assert.equal(t.origem_url!.length, 300);
  assert.equal(t.projeto!.length, 300);
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

test("applyClientFilters: o PEDIDO também é canonicalizado ('To-do'/'A fazer' acham status 'todo')", () => {
  const tasks = [mk({ id: "1", status: "todo" }), mk({ id: "2", status: "done" })];
  assert.deepEqual(applyClientFilters(tasks, { status: ["To-do"] }).map((t) => t.id), ["1"]);
  assert.deepEqual(applyClientFilters(tasks, { status: ["A fazer"] }).map((t) => t.id), ["1"]);
});

test("applyClientFilters: prazo_de/ate comparam só o DIA (datetime entra na janela do dia)", () => {
  const tasks = [
    mk({ id: "dt", prazo: "2026-06-11T15:00:00-03:00" }),
    mk({ id: "cedo", prazo: "2026-06-09" }),
    mk({ id: "semprazo" }),
  ];
  assert.deepEqual(
    applyClientFilters(tasks, { prazo_ate: "2026-06-11" }).map((t) => t.id),
    ["dt", "cedo"],
  );
  assert.deepEqual(
    applyClientFilters(tasks, { prazo_de: "2026-06-10", prazo_ate: "2026-06-11" }).map((t) => t.id),
    ["dt"],
  );
  assert.deepEqual(applyClientFilters(tasks, { prazo_ate: "2026-06-08" }), []);
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

test("listTasks: segue next_cursor — board resume TODAS as páginas, limit só fatia o retorno", async () => {
  const mkPage = (id: string, status: string, due?: string) => ({
    id,
    url: null,
    properties: {
      Task: { type: "title", title: [{ plain_text: id }] },
      Status: { type: "status", status: { name: status } },
      ...(due ? { "Due date": { type: "date", date: { start: due } } } : {}),
    },
  });
  const page1 = [mkPage("a1", "To-do", "2026-06-12"), mkPage("a2", "Done")];
  const page2 = [mkPage("b1", "In progress"), mkPage("b2", "To-do", "2026-06-01")]; // b2 overdue
  const bodies: any[] = [];
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_OWNER };
      if (init?.method === "POST" && url.includes("/query")) {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (!body.start_cursor) return { body: { results: page1, has_more: true, next_cursor: "c2" } };
        return { body: { results: page2, has_more: false, next_cursor: null } };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-owner",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
    now: new Date("2026-06-10T15:00:00Z"),
  };
  const r = await listTasks("friend:pag1", { limit: 2 }, deps);
  assert.equal(bodies.length, 2, "seguiu o cursor");
  assert.equal(bodies[1].start_cursor, "c2");
  // limit fatia o retorno…
  assert.equal(r.tasks.length, 2);
  // …mas o board cobre as 3 abertas das DUAS páginas (Done fora por default).
  assert.equal(r.board.abertos, 3);
  assert.equal(r.board.overdue_count, 1);
  assert.equal(r.truncated, false);
});

test("listTasks: para no cap de 500 linhas com has_more → truncated:true", async () => {
  const mkPage = (id: string) => ({
    id,
    properties: { Task: { type: "title", title: [{ plain_text: id }] } },
  });
  let queries = 0;
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_OWNER };
      if (init?.method === "POST" && url.includes("/query")) {
        queries += 1;
        return {
          body: {
            results: Array.from({ length: 100 }, (_, i) => mkPage(`p${queries}-${i}`)),
            has_more: true,
            next_cursor: `c${queries + 1}`,
          },
        };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-owner",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
  };
  const r = await listTasks("friend:pag2", { limit: 5 }, deps);
  assert.equal(queries, 5, "500 linhas = 5 páginas de 100, depois para");
  assert.equal(r.truncated, true);
  assert.equal(r.tasks.length, 5);
  assert.equal(r.board.abertos, 500);
});

test("listTasks: overdue do board usa o dia no fuso do usuário (00:30Z = dia anterior em BRT)", async () => {
  // Instante 2026-06-11T00:30Z = 2026-06-10 21:30 em America/Sao_Paulo.
  // Prazo 2026-06-10 NÃO está atrasado (ainda é dia 10 pro usuário);
  // prazo 2026-06-09 está.
  const mkPage = (id: string, due: string) => ({
    id,
    properties: {
      Task: { type: "title", title: [{ plain_text: id }] },
      Status: { type: "status", status: { name: "To-do" } },
      "Due date": { type: "date", date: { start: due } },
    },
  });
  const deps = {
    fetchImpl: fakeFetch((url, init) => {
      if (init?.method === "GET" && url.includes("/v1/data_sources/")) return { body: SCHEMA_OWNER };
      if (init?.method === "POST" && url.includes("/query")) {
        return { body: { results: [mkPage("hoje", "2026-06-10"), mkPage("ontem", "2026-06-09")] } };
      }
      return undefined;
    }),
    getTasksDbIdImpl: async () => "ds-owner",
    resolveTokensImpl: async () => [{ workspace: "w", token: "t" }],
    now: new Date("2026-06-11T00:30:00Z"),
  };
  const r = await listTasks("friend:tz", {}, deps);
  assert.equal(r.board.overdue_count, 1, "só o prazo 06-09 está atrasado em BRT");
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
