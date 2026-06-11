// src/portal/task-write.ts
// 001-account-portal / WS2 — create a task/event PAGE in the friend's Notion
// "Tarefas" data source, conversationally.
//
// 003-tasks-v1: this is now a THIN compatibility wrapper over the canonical
// task pipeline in src/tasks/write.ts (profile-driven, works with ANY schema).
// createTaskPage keeps its exact signature — portal/ask-actions.ts and the
// zinom task tools depend on it. Token resolution moved to
// tasks/adapter.resolveNotionTokens (covers both friend vault and owner .env).
import { createTask } from "../tasks/write.js";
import type { AdapterDeps } from "../tasks/adapter.js";

// Re-exported so existing `instanceof NoNotionError` checks keep working
// against the single canonical class.
export { NoNotionError } from "../tasks/adapter.js";

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

/** LEGACY pure builder for the FIXED standard schema (Nome/Prazo/Status). The
 *  live write path now builds payloads through the TrackerProfile
 *  (tasks/write.buildCreatePagePayload, schema-aware); this stays exported for
 *  the existing unit tests and as the reference of the old behavior. */
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

export interface CreatedTask {
  pageId: string;
  url: string | null;
  dataSourceId: string;
  created: boolean;
}

/** Create a task/event page in the account's Tasks data source. Auto-creates
 *  the "🧠 Zinom → Tarefas" tracker on first use if none is configured yet.
 *  Signature preserved; delegates to tasks/write.createTask (canonical model). */
export async function createTaskPage(
  accountId: string,
  input: CreateTaskInput,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CreatedTask> {
  const deps: AdapterDeps = {};
  if (opts.fetchImpl) deps.fetchImpl = opts.fetchImpl;
  return createTask(
    accountId,
    {
      title: input.title,
      prazo: input.date,
      prazo_fim: input.endDate,
      status: input.status,
      note: input.note,
    },
    deps,
  );
}
