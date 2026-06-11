// src/tasks/__tests__/fixtures.ts — the 4 reference schemas from the spec, in
// the raw GET /v1/data_sources/{id} shape the adapter consumes. Shared by the
// table-driven adapter/read/write/upgrade tests (NOT a test file itself).

/** Standard NEW template (003-tasks-v1 TARGET_PROPERTIES, as Notion returns it). */
export const SCHEMA_STANDARD_NEW = {
  id: "ds-new",
  title: [{ plain_text: "Tarefas" }],
  parent: { type: "database_id", database_id: "11112222-3333-4444-5555-666677778888" },
  properties: {
    Nome: { type: "title", title: {} },
    Status: {
      type: "select",
      select: {
        options: [
          { id: "s1", name: "Backlog", color: "gray" },
          { id: "s2", name: "A fazer", color: "blue" },
          { id: "s3", name: "Em andamento", color: "yellow" },
          { id: "s4", name: "Bloqueada", color: "red" },
          { id: "s5", name: "Concluída", color: "green" },
          { id: "s6", name: "Cancelada", color: "gray" },
        ],
      },
    },
    Prioridade: {
      type: "select",
      select: {
        options: [
          { id: "p1", name: "Urgente", color: "red" },
          { id: "p2", name: "Alta", color: "yellow" },
          { id: "p3", name: "Média", color: "blue" },
          { id: "p4", name: "Baixa", color: "gray" },
        ],
      },
    },
    Prazo: { type: "date", date: {} },
    "Tempo estimado (min)": { type: "number", number: { format: "number" } },
    Tipo: {
      type: "select",
      select: {
        options: [
          { id: "t1", name: "Fazer", color: "blue" },
          { id: "t2", name: "Cobrar", color: "purple" },
        ],
      },
    },
    Quem: { type: "rich_text", rich_text: {} },
    Origem: { type: "url", url: {} },
    Projeto: { type: "select", select: { options: [] } },
    "Criada em": { type: "created_time", created_time: {} },
    "Concluída em": { type: "date", date: {} },
  },
} as const;

/** Standard OLD template (pre-003: select A fazer/Fazendo/Feito + Frente). */
export const SCHEMA_STANDARD_OLD = {
  id: "ds-old",
  title: [{ plain_text: "Tarefas" }],
  properties: {
    Nome: { type: "title", title: {} },
    Status: {
      type: "select",
      select: {
        options: [
          { id: "o1", name: "A fazer", color: "default" },
          { id: "o2", name: "Fazendo", color: "blue" },
          { id: "o3", name: "Feito", color: "green" },
        ],
      },
    },
    Prazo: { type: "date", date: {} },
    "Tempo estimado": { type: "number", number: { format: "number" } },
    Frente: { type: "select", select: { options: [{ id: "f1", name: "Pessoal", color: "purple" }] } },
  },
} as const;

/** The owner's board: English status-TYPE, Priority Ultra/High/Medium/Low,
 *  Due date, Tempo estimado (minutes), Projeto multi_select. */
export const SCHEMA_OWNER = {
  id: "ds-owner",
  title: [{ plain_text: "Tasks Tracker" }],
  properties: {
    Task: { type: "title", title: {} },
    Status: {
      type: "status",
      status: {
        options: [
          { id: "st1", name: "Backlog", color: "gray" },
          { id: "st2", name: "To-do", color: "blue" },
          { id: "st3", name: "Blocked", color: "red" },
          { id: "st4", name: "In progress", color: "yellow" },
          { id: "st5", name: "Canceled", color: "gray" },
          { id: "st6", name: "Done", color: "green" },
        ],
        groups: [],
      },
    },
    Priority: {
      type: "select",
      select: {
        options: [
          { id: "pr1", name: "Ultra" },
          { id: "pr2", name: "High" },
          { id: "pr3", name: "Medium" },
          { id: "pr4", name: "Low" },
        ],
      },
    },
    "Due date": { type: "date", date: {} },
    "Tempo estimado": { type: "number", number: { format: "number" } },
    Projeto: { type: "multi_select", multi_select: { options: [{ id: "pj1", name: "Zinom" }] } },
  },
} as const;

/** Degenerate base: nothing beyond the title (graceful: create with title,
 *  list without status). */
export const SCHEMA_TITLE_ONLY = {
  id: "ds-min",
  title: [{ plain_text: "Minhas Tarefas" }],
  properties: {
    Nome: { type: "title", title: {} },
  },
} as const;

/** Fake fetch routed by (url, init) → { status?, body? }. */
export function fakeFetch(
  handler: (url: string, init?: any) => { status?: number; body?: unknown } | undefined,
): typeof fetch {
  return (async (url: string, init?: any) => {
    const r = handler(String(url), init) ?? {};
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as any;
}
