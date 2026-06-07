// src/portal/task-write.ts
// 001-account-portal / WS2 — create a task/event PAGE in the friend's Notion
// "Tarefas" data source, conversationally (the zinom_create_task MCP tool calls
// this). Clients-free (raw fetch + the account's vault PAT), reusing the Task
// Tracker that activation already detects/creates. Account-scoped by construction:
// the caller passes accountId (from the trusted request context, never input).
//
// Multi-workspace by design: a friend may connect SEVERAL Notion workspaces with
// arbitrary names. The Tasks data source lives in exactly one of them, so we try
// each warmed workspace's PAT until one can read the data source, then write with
// that same token. No assumption that there is only one workspace.
import { warmAccount, getAccountToken } from "../account-tokens.js";
import { getTasksDbId, createTaskTracker } from "./task-tracker.js";

const NOTION_VERSION = "2025-09-03"; // keep in sync with clients.ts / task-tracker.ts
const NOTION_API = "https://api.notion.com";

export interface CreateTaskInput {
  /** Task/event title (the "Nome" title property). */
  title: string;
  /** Optional ISO date or datetime for the "Prazo" date property — the START
   *  (e.g. "2026-06-09" or "2026-06-09T20:00:00-03:00"). */
  date?: string;
  /** Optional ISO datetime for the END of a time block. Only used when `date` is
   *  also set → Prazo becomes a {start,end} range (Notion renders it as a time
   *  block on a calendar view). Ignored without a start. */
  endDate?: string;
  /** Optional "Status" select value (defaults to the DB's first option / left unset). */
  status?: string;
  /** Optional free-text note appended as a paragraph in the page body. */
  note?: string;
}

/** PURE: build the POST /v1/pages payload for a task page under a data source.
 *  Properties match the Task Tracker schema (Nome=title, Prazo=date, Status=select).
 *  Exported for unit tests — no network, no account state. */
export function buildTaskPagePayload(
  dataSourceId: string,
  input: CreateTaskInput,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    Nome: { title: [{ type: "text", text: { content: input.title.slice(0, 2000) } }] },
  };
  if (input.date && input.date.trim()) {
    const range: { start: string; end?: string } = { start: input.date.trim() };
    if (input.endDate && input.endDate.trim()) range.end = input.endDate.trim();
    properties.Prazo = { date: range };
  }
  if (input.status && input.status.trim()) {
    properties.Status = { select: { name: input.status.trim() } };
  }
  const payload: Record<string, unknown> = {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties,
  };
  if (input.note && input.note.trim()) {
    payload.children = [
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: input.note.slice(0, 2000) } }] },
      },
    ];
  }
  return payload;
}

async function notionFetch(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; data: any }> {
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
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

/** Find which connected workspace's PAT can read the given data source. Tries
 *  each warmed workspace token (GET /v1/data_sources/{id}); returns the first that
 *  succeeds. Handles friends with multiple, arbitrarily-named workspaces. */
async function resolveTokenForDataSource(
  accountId: string,
  dataSourceId: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const workspaces = await warmAccount(accountId);
  let firstToken: string | null = null;
  for (const ws of workspaces) {
    const token = getAccountToken(accountId, ws, "pat");
    if (!token) continue;
    if (!firstToken) firstToken = token;
    const r = await notionFetch(token, `/v1/data_sources/${dataSourceId}`, { method: "GET" }, fetchImpl);
    if (r.ok) return token;
  }
  // None confirmed readable (e.g. transient error): fall back to the first PAT so
  // the create still attempts rather than hard-failing on a flaky GET.
  return firstToken;
}

export class NoNotionError extends Error {
  constructor() {
    super("conecte seu Notion no portal antes de criar tarefas");
    this.name = "NoNotionError";
  }
}

export interface CreatedTask {
  pageId: string;
  url: string | null;
  dataSourceId: string;
  created: boolean;
}

/** Create a task/event page in the friend's Tasks data source. Auto-creates the
 *  "🧠 Zinom → Tarefas" tracker on first use if none is configured yet. */
export async function createTaskPage(
  accountId: string,
  input: CreateTaskInput,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CreatedTask> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!input.title || !input.title.trim()) {
    throw new Error("título obrigatório");
  }

  // Need at least one Notion workspace connected to write anywhere.
  const workspaces = await warmAccount(accountId);
  const hasNotion = workspaces.some((ws) => getAccountToken(accountId, ws, "pat"));
  if (!hasNotion) throw new NoNotionError();

  // Resolve (or first-time create) the Tasks data source.
  let dataSourceId = await getTasksDbId(accountId);
  let created = false;
  if (!dataSourceId) {
    const r = await createTaskTracker(accountId, { fetchImpl });
    dataSourceId = r.dataSourceId;
    created = r.created; // false when an existing "Tarefas" was reused
  }

  const token = await resolveTokenForDataSource(accountId, dataSourceId, fetchImpl);
  if (!token) throw new NoNotionError();

  const res = await notionFetch(
    token,
    "/v1/pages",
    { method: "POST", body: JSON.stringify(buildTaskPagePayload(dataSourceId, input)) },
    fetchImpl,
  );
  if (!res.ok) {
    throw new Error(`Notion /v1/pages: HTTP ${res.status} ${res.data?.code ?? ""} ${res.data?.message ?? ""}`.trim());
  }
  return { pageId: res.data?.id ?? "", url: res.data?.url ?? null, dataSourceId, created };
}
