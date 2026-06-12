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
import { DEFAULT_ACCOUNT_ID } from "../context.js";
import { getAccountSecret, setAccountSecret } from "../secrets.js";
import {
  classifyResults,
  findReusableTrackerId,
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

export type DetectResult =
  | Detection
  | { status: "no-notion"; candidates: [] }
  | { status: "workspace_required"; workspaces: string[]; candidates: [] };

/** Conta com mais de um Notion conectado precisa ESCOLHER onde agir. Detectada
 *  por `name` (não instanceof) nos outros módulos. */
export class WorkspaceRequiredError extends Error {
  readonly workspaces: string[];
  constructor(workspaces: string[]) {
    super(`escolha um workspace do Notion: ${workspaces.join(", ")}`);
    this.name = "WorkspaceRequiredError";
    this.workspaces = workspaces;
  }
}

function ownerEnvTokens(): Array<{ workspace: string; token: string }> {
  const pairs: Array<[string, string | undefined]> = [
    ["personal", process.env.NOTION_PERSONAL_TOKEN],
    ["globalcripto", process.env.NOTION_GLOBALCRIPTO_TOKEN],
    ["nora", process.env.NOTION_NORA_TOKEN],
  ];
  return pairs.filter(([, t]) => !!t).map(([workspace, token]) => ({ workspace, token: token! }));
}

/** Todos os pares workspace+token Notion da conta (owner = .env; friend = vault). */
export async function listAccountNotionTokens(
  accountId: string,
): Promise<Array<{ workspace: string; token: string }>> {
  if (accountId === DEFAULT_ACCOUNT_ID) return ownerEnvTokens();
  const workspaces = await warmAccount(accountId);
  const out: Array<{ workspace: string; token: string }> = [];
  for (const ws of workspaces) {
    const token = getAccountToken(accountId, ws, "pat");
    if (token) out.push({ workspace: ws, token });
  }
  return out;
}

/** Token + workspace da conta. Com `preferred`: SÓ esse workspace; sem token
 *  nele → erro nominal. Sem `preferred`: único workspace conectado, ou
 *  WorkspaceRequiredError quando há mais de um (fim do `all[0]` silencioso —
 *  causa do bug 2026-06-12). */
async function resolveAccountNotion(
  accountId: string,
  preferred?: string,
): Promise<{ token: string; workspace: string } | null> {
  const all = await listAccountNotionTokens(accountId);
  if (preferred) {
    const hit = all.find((t) => t.workspace === preferred);
    if (!hit) throw new Error(`sem Notion conectado no workspace "${preferred}"`);
    return hit;
  }
  if (all.length > 1) throw new WorkspaceRequiredError(all.map((t) => t.workspace));
  return all[0] ?? null;
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
  opts: { fetchImpl?: typeof fetch; workspace?: string } = {},
): Promise<DetectResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let conn;
  try {
    conn = await resolveAccountNotion(accountId, opts.workspace);
  } catch (err: any) {
    if (err?.name === "WorkspaceRequiredError") {
      return { status: "workspace_required", workspaces: err.workspaces, candidates: [] };
    }
    throw err;
  }
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

export interface CreateTrackerOptions {
  fetchImpl?: typeof fetch;
  /** owner: personal|globalcripto|nora; friend: workspace id do vault. */
  workspace?: string;
  /** Página existente (id 32-hex) onde criar a DB. Pula reuse-guard e página-mãe. */
  parentPageId?: string;
}

/** Cria "🧠 Zinom" (topo do workspace) + DB "Tarefas" dentro, grava o data_source
 *  id. Search-before-create: se já existir uma DB "Tarefas" (ex.: um run anterior
 *  criou mas não persistiu o id), REUSA em vez de criar uma "🧠 Zinom" duplicada.
 *  `created` é false quando reusou. Com `parentPageId` explícito a DB nasce sob
 *  essa página, SEM reuse-guard e SEM página-mãe (a pessoa disse onde quer). */
export async function createTaskTracker(
  accountId: string,
  opts: CreateTrackerOptions = {},
): Promise<{ dataSourceId: string; created: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = await resolveAccountNotion(accountId, opts.workspace);
  if (!conn) throw new Error("conecte o Notion antes de criar as Tarefas");

  if (opts.parentPageId) {
    // Alvo explícito: a pessoa disse ONDE quer — sem reuse-guard e sem "🧠 Zinom".
    const db = await notionFetch(
      conn.token,
      "/v1/databases",
      { method: "POST", body: JSON.stringify(buildCreateDbPayload(opts.parentPageId)) },
      fetchImpl,
    );
    const dataSourceId: string = db?.data_sources?.[0]?.id ?? db?.id;
    if (!dataSourceId) throw new Error("Notion não retornou o id da base criada");
    await setTasksDbId(accountId, dataSourceId);
    await invalidateProfileSafe(accountId);
    return { dataSourceId, created: true };
  }

  // Search-before-create guard (best-effort: a transient search failure must not
  // block creation).
  try {
    const out = await notionFetch(
      conn.token,
      "/v1/search",
      { method: "POST", body: JSON.stringify({ filter: { property: "object", value: "data_source" } }) },
      fetchImpl,
    );
    const hits: Array<{ id: string; title: string }> = (out.results ?? [])
      .filter((r: any) => r?.id)
      .map((r: any) => ({ id: r.id, title: plainTitle(r.title) }));
    const reuse = findReusableTrackerId(hits);
    if (reuse) {
      await setTasksDbId(accountId, reuse);
      // 003-tasks-v1: a reused "Tarefas" may predate the new template — bring it
      // up to date additively. Best-effort: an upgrade failure must not block
      // the reuse (dynamic import also avoids a module cycle with tasks/).
      try {
        const { upgradeStandardTracker } = await import("../tasks/upgrade.js");
        const { invalidateTrackerProfile } = await import("../tasks/adapter.js");
        invalidateTrackerProfile(accountId);
        await upgradeStandardTracker(accountId, { fetchImpl });
      } catch (err: any) {
        console.warn(`[task-tracker] ${accountId}: reuse upgrade failed: ${err?.message ?? err}`);
      }
      return { dataSourceId: reuse, created: false };
    }
  } catch (err: any) {
    console.warn(`[task-tracker] ${accountId}: search-before-create failed: ${err?.message ?? err}`);
  }

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
  // Todo write de tasks_db derruba o profile cacheado — senão o adapter segue
  // lendo a base antiga por até 5 min.
  await invalidateProfileSafe(accountId);
  return { dataSourceId, created: true };
}

/** Derruba o profile cacheado do adapter, best-effort. (Import dinâmico:
 *  task-tracker↔adapter teria ciclo estático; mesmo padrão do branch de reuse.) */
async function invalidateProfileSafe(accountId: string): Promise<void> {
  try {
    const { invalidateTrackerProfile } = await import("../tasks/adapter.js");
    invalidateTrackerProfile(accountId);
  } catch (err: any) {
    console.warn(`[task-tracker] ${accountId}: invalidate failed: ${err?.message ?? err}`);
  }
}

export interface ParentPageCandidate { id: string; title: string; url: string | null; workspace: string }

function pageTitleOf(page: any): string {
  for (const v of Object.values(page?.properties ?? {})) {
    if ((v as any)?.type === "title") return plainTitle((v as any).title);
  }
  return plainTitle(page?.title);
}

/** Busca páginas candidatas a "casa" da base, em todos os Notion conectados. */
export async function searchParentPages(
  accountId: string,
  query: string,
  opts: { fetchImpl?: typeof fetch; workspace?: string } = {},
): Promise<ParentPageCandidate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let tokens = await listAccountNotionTokens(accountId);
  if (opts.workspace) tokens = tokens.filter((t) => t.workspace === opts.workspace);
  const out: ParentPageCandidate[] = [];
  for (const { workspace, token } of tokens) {
    try {
      const r = await notionFetch(
        token,
        "/v1/search",
        { method: "POST", body: JSON.stringify({ query, filter: { property: "object", value: "page" }, page_size: 10 }) },
        fetchImpl,
      );
      for (const p of r.results ?? []) {
        if (!p?.id) continue;
        out.push({ id: p.id, title: pageTitleOf(p) || "(sem título)", url: p.url ?? null, workspace });
      }
    } catch (err: any) {
      console.warn(`[task-tracker] ${accountId}: search pages ${workspace}: ${err?.message ?? err}`);
    }
  }
  return out;
}

/** Em qual workspace conectado a página é legível (primeiro token que lê ganha). */
export async function findWorkspaceForPage(
  accountId: string,
  pageId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ workspace: string; title: string; url: string | null } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const { workspace, token } of await listAccountNotionTokens(accountId)) {
    try {
      const p = await notionFetch(token, `/v1/pages/${pageId}`, { method: "GET" }, fetchImpl);
      if (p?.id) return { workspace, title: pageTitleOf(p) || "(sem título)", url: p.url ?? null };
    } catch {
      /* este token não lê a página — tenta o próximo */
    }
  }
  return null;
}
