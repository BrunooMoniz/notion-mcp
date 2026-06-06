// src/portal/task-tracker.ts
// 001-account-portal / ativação — camada de rede + persistência do Task Tracker.
// Clients-free: chama a API do Notion via fetch cru (igual src/notion-oauth.ts),
// com o token da conta resolvido do vault. tasks_db_id mora no vault (kind
// "tasks_db"), então NÃO precisa de migração. fetchImpl é injetável p/ teste.
//
// Notion 2025-09-03: o objeto data_source do /v1/search traz só id/title (sem
// properties); por isso a detecção faz GET /v1/data_sources/{id} por candidata
// (com cap) pra obter o schema. O create de DB põe o schema em
// initial_data_source e a resposta traz data_sources[].id.
import { warmAccount, getAccountToken } from "../account-tokens.js";
import { getAccountSecret, setAccountSecret } from "../secrets.js";
import {
  classifyResults,
  buildParentPagePayload,
  buildCreateDbPayload,
  type Detection,
  type DataSourceLite,
} from "./task-tracker-schema.js";

const NOTION_VERSION = "2025-09-03"; // manter em sincronia com clients.ts
const NOTION_API = "https://api.notion.com";
const TASKS_DB_KIND = "tasks_db";
// Quantas data sources inspecionar (1 GET de schema cada) na detecção. Bound de
// custo/latência; workspaces com mais que isso são truncados (logado).
const MAX_INSPECT = 40;

export type DetectResult = Detection | { status: "no-notion"; candidates: [] };

/** Token + workspace da conta (primeiro workspace com token), ou null. */
async function resolveAccountNotion(
  accountId: string,
): Promise<{ token: string; workspace: string } | null> {
  const workspaces = await warmAccount(accountId);
  for (const ws of workspaces) {
    const token = getAccountToken(accountId, ws, "pat");
    if (token) return { token, workspace: ws };
  }
  return null;
}

async function notionFetch(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Notion: resposta não-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`Notion ${path}: HTTP ${res.status} ${data?.code ?? ""} ${data?.message ?? ""}`.trim());
  }
  return data;
}

function plainTitle(title: unknown): string {
  if (!Array.isArray(title)) return "";
  return title.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("").trim();
}

/** Detecta candidatas a Task Tracker no Notion da conta. Sem Notion → no-notion.
 *  search dá id+title; um GET por candidata (até MAX_INSPECT) busca o schema. */
export async function detectTaskTracker(
  accountId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<DetectResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = await resolveAccountNotion(accountId);
  if (!conn) return { status: "no-notion", candidates: [] };

  const out = await notionFetch(
    conn.token,
    "/v1/search",
    { method: "POST", body: JSON.stringify({ filter: { property: "object", value: "data_source" } }) },
    fetchImpl,
  );
  const hits: Array<{ id: string; title: string }> = (out.results ?? [])
    .filter((r: any) => r?.id)
    .map((r: any) => ({ id: r.id, title: plainTitle(r.title) }));

  if (hits.length > MAX_INSPECT) {
    console.warn(`[task-tracker] ${accountId}: ${hits.length} data sources, inspecting first ${MAX_INSPECT}`);
  }
  const inspect = hits.slice(0, MAX_INSPECT);

  const full: DataSourceLite[] = [];
  for (const h of inspect) {
    try {
      const ds = await notionFetch(conn.token, `/v1/data_sources/${h.id}`, { method: "GET" }, fetchImpl);
      full.push({ id: h.id, title: h.title || plainTitle(ds.title), properties: ds.properties ?? {} });
    } catch (err: any) {
      // Uma data source que não dá pra ler não vira candidata — segue.
      console.warn(`[task-tracker] ${accountId}: skip ${h.id}: ${err?.message ?? err}`);
    }
  }
  return classifyResults(full);
}

export async function getTasksDbId(accountId: string): Promise<string | null> {
  return (await getAccountSecret(accountId, TASKS_DB_KIND)) ?? null;
}

export async function setTasksDbId(accountId: string, dataSourceId: string): Promise<void> {
  await setAccountSecret(accountId, TASKS_DB_KIND, dataSourceId);
}

/** Usa uma DB existente escolhida pela pessoa: só grava o id (MVP não muta schema). */
export async function useExistingTracker(accountId: string, dataSourceId: string): Promise<void> {
  await setTasksDbId(accountId, dataSourceId);
}

/** Cria "🧠 Zinom" (topo do workspace) + DB "Tarefas" dentro, grava o data_source id. */
export async function createTaskTracker(
  accountId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ dataSourceId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = await resolveAccountNotion(accountId);
  if (!conn) throw new Error("conecte o Notion antes de criar as Tarefas");

  const page = await notionFetch(
    conn.token,
    "/v1/pages",
    { method: "POST", body: JSON.stringify(buildParentPagePayload()) },
    fetchImpl,
  );
  if (!page?.id) throw new Error("não consegui criar a página-mãe no Notion");

  const db = await notionFetch(
    conn.token,
    "/v1/databases",
    { method: "POST", body: JSON.stringify(buildCreateDbPayload(page.id)) },
    fetchImpl,
  );
  // 2025-09-03: o database criado expõe data_sources[]; guardamos o id do data
  // source (é o que se consulta). Fallback p/ o id do database se ausente.
  const dataSourceId: string = db?.data_sources?.[0]?.id ?? db?.id;
  if (!dataSourceId) throw new Error("Notion não retornou o id da base criada");
  await setTasksDbId(accountId, dataSourceId);
  return { dataSourceId };
}
