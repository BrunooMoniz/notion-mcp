// src/portal/task-tracker-schema.ts
// 001-account-portal / ativação — classificação PURA de data sources do Notion
// (decide se uma DB é candidata a Task Tracker) e builders dos payloads de criação.
// Sem imports de rede/storage: 100% testável.

export const ZINOM_PARENT_TITLE = "🧠 Zinom";
export const TARGET_DB_TITLE = "Tarefas";

/** Schema-alvo da DB "Tarefas" — o mínimo que o /meu-dia espera. */
export const TARGET_PROPERTIES: Record<string, any> = {
  Nome: { title: {} },
  Status: {
    select: { options: [{ name: "A fazer" }, { name: "Fazendo" }, { name: "Feito" }] },
  },
  Prazo: { date: {} },
  "Tempo estimado": { number: { format: "number" } },
  Frente: { select: { options: [] } },
};

const TASKLIKE_NAME_RE = /tarefa|task|to-?do|afazer/i;

/** Remove acentos e baixa a caixa, pra casar nome de DB de forma robusta. */
function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

type NotionProps = Record<string, { type?: string; select?: { options?: Array<{ name?: string }> } }>;

/** Algum campo é "status-like": type status, ou um select cujo nome/opções soam a status. */
export function hasStatusLike(properties: NotionProps): boolean {
  for (const [name, def] of Object.entries(properties ?? {})) {
    if (def?.type === "status") return true;
    if (def?.type === "select") {
      const n = normalize(name);
      if (/status|situa|estado|stage|etapa/.test(n)) return true;
      const opts = (def.select?.options ?? []).map((o) => normalize(o.name ?? "")).join(" ");
      if (/fazer|fazendo|feito|done|todo|to do|andamento|conclu/.test(opts)) return true;
    }
  }
  return false;
}

/** Algum campo é do tipo date. */
export function hasDateLike(properties: NotionProps): boolean {
  return Object.values(properties ?? {}).some((d) => d?.type === "date");
}

export interface DataSourceLite {
  id: string;
  title: string;
  properties: NotionProps;
}

export function isTaskTrackerCandidate(ds: { title: string; properties: NotionProps }): boolean {
  if (TASKLIKE_NAME_RE.test(normalize(ds.title))) return true;
  return hasStatusLike(ds.properties) && hasDateLike(ds.properties);
}

export interface Detection {
  status: "none" | "one" | "many";
  candidates: Array<{ id: string; title: string }>;
}

export function classifyResults(dataSources: DataSourceLite[]): Detection {
  const candidates = dataSources
    .filter((d) => isTaskTrackerCandidate(d))
    .map((d) => ({ id: d.id, title: d.title }));
  const status = candidates.length === 0 ? "none" : candidates.length === 1 ? "one" : "many";
  return { status, candidates };
}

/** Payload de POST /v1/pages: página-mãe "🧠 Zinom" no topo do workspace. */
export function buildParentPagePayload(): {
  parent: { type: "workspace"; workspace: true };
  properties: { title: { title: Array<{ text: { content: string } }> } };
} {
  return {
    parent: { type: "workspace", workspace: true },
    properties: { title: { title: [{ text: { content: ZINOM_PARENT_TITLE } }] } },
  };
}

/** Payload de POST /v1/databases (Notion 2025-09-03): o schema vai em
 *  `initial_data_source.properties` (mudou nessa versão). */
export function buildCreateDbPayload(parentPageId: string): {
  parent: { type: "page_id"; page_id: string };
  title: Array<{ type: "text"; text: { content: string } }>;
  initial_data_source: { properties: Record<string, any> };
} {
  return {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: TARGET_DB_TITLE } }],
    initial_data_source: { properties: TARGET_PROPERTIES },
  };
}
