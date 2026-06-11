// src/tasks/read.ts
// 003-tasks-v1 — canonical task reads. listTasks() queries the account's
// tracker data source with filters built from the TrackerProfile, converts
// pages to canonical Tasks, sorts (prazo asc, no-prazo last, tie-break
// priority) and summarizes the board. Pure builders are exported for tests;
// network goes through rawNotionFetch with an injectable fetchImpl.
import {
  loadTrackerProfile,
  invalidateTrackerProfile,
  rawNotionFetch,
  rawErrorMessage,
  resolveStatusOptionName,
  type TrackerProfile,
  type AdapterDeps,
} from "./adapter.js";
import {
  normalize,
  canonicalStatusFor,
  canonicalTipoFor,
  priorityRank,
  isClosedStatus,
  type Task,
} from "./model.js";
import { localDateInTz, DEFAULT_TIMEZONE } from "./plan-context.js";

export interface ListTasksOptions {
  /** Canonical statuses (or literal option names — passthrough). */
  status?: string[];
  /** Default false: done/canceled excluded unless an explicit status asks. */
  incluir_concluidas?: boolean;
  prazo_de?: string; // YYYY-MM-DD
  prazo_ate?: string; // YYYY-MM-DD
  /** Title substring search. */
  q?: string;
  /** Default 25, max 100. */
  limit?: number;
}

export interface TaskBoard {
  by_status: Record<string, number>;
  abertos: number;
  /** Sum of tempo_estimado_min over OPEN tasks. */
  estimado_min: number;
  overdue_count: number;
}

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? 25);
  if (!Number.isFinite(n) || n < 1) return 25;
  return Math.min(n, 100);
}

/** Pagination cap: how many rows listTasks accumulates across pages before
 *  giving up (and flagging `truncated`). Keeps the board summary honest on big
 *  bases without unbounded scans. */
export const MAX_SCAN_ROWS = 500;
/** Notion's max page_size — always scan at full width; `limit` only slices the
 *  returned tasks, the board summary needs ALL (filtered) rows. */
const SCAN_PAGE_SIZE = 100;

function statusFilterValue(profile: TrackerProfile, value: string): string | null {
  const sp = profile.props.status;
  if (!sp) return null;
  try {
    return resolveStatusOptionName(sp, value);
  } catch {
    // status-kind base without that option: nothing can match server-side; the
    // client-side post-filter still applies.
    return null;
  }
}

/** PURE: the POST /v1/data_sources/{id}/query body for the given options. */
export function buildListQuery(profile: TrackerProfile, opts: ListTasksOptions): Record<string, unknown> {
  const and: any[] = [];
  const sp = profile.props.status;

  const eq = (option: string) =>
    sp!.kind === "status"
      ? { property: sp!.name, status: { equals: option } }
      : { property: sp!.name, select: { equals: option } };
  const neq = (option: string) =>
    sp!.kind === "status"
      ? { property: sp!.name, status: { does_not_equal: option } }
      : { property: sp!.name, select: { does_not_equal: option } };

  if (sp && opts.status?.length) {
    const or = opts.status
      .map((s) => statusFilterValue(profile, s))
      .filter((o): o is string => !!o)
      .map(eq);
    if (or.length === 1) and.push(or[0]);
    else if (or.length > 1) and.push({ or });
  } else if (sp && !opts.incluir_concluidas) {
    // Exclude every REAL option that maps to done/canceled.
    for (const opt of sp.options) {
      const c = sp.reverse[normalize(opt)];
      if (c === "done" || c === "canceled") and.push(neq(opt));
    }
  }

  if (profile.props.prazo) {
    const name = profile.props.prazo.name;
    if (opts.prazo_de) and.push({ property: name, date: { on_or_after: opts.prazo_de } });
    if (opts.prazo_ate) and.push({ property: name, date: { on_or_before: opts.prazo_ate } });
  }
  if (opts.q && opts.q.trim()) {
    and.push({ property: profile.props.title, title: { contains: opts.q.trim() } });
  }

  const body: Record<string, unknown> = { page_size: SCAN_PAGE_SIZE };
  if (and.length === 1) body.filter = and[0];
  else if (and.length > 1) body.filter = { and };
  if (profile.props.prazo) {
    body.sorts = [{ property: profile.props.prazo.name, direction: "ascending" }];
  }
  return body;
}

// --- page → canonical Task ------------------------------------------------------

function richTextPlain(prop: any): string {
  const arr = prop?.rich_text ?? prop?.title;
  if (!Array.isArray(arr)) return "";
  return arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("").trim();
}

/** Hardening: cap free-text fields so a pathological page can't blow up the
 *  tool payload (titles/quem/projeto/origem are display strings, not docs). */
const MAX_FIELD_CHARS = 300;
function capText(s: string): string {
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

/** PURE: convert a Notion page object to the canonical Task via the profile. */
export function pageToTask(profile: TrackerProfile, page: any): Task {
  const props = page?.properties ?? {};
  const p = profile.props;

  const task: Task = {
    id: page?.id ?? "",
    url: page?.url ?? null,
    title: capText(richTextPlain(props[p.title])) || "(sem título)",
    status: "",
  };

  if (p.status) {
    const raw = props[p.status.name]?.status?.name ?? props[p.status.name]?.select?.name ?? "";
    task.status = raw ? (p.status.reverse[normalize(raw)] ?? raw) : "";
  }
  if (p.prioridade) {
    const raw = props[p.prioridade.name]?.select?.name ?? "";
    if (raw) task.prioridade = p.prioridade.reverse[normalize(raw)] ?? raw;
  }
  if (p.prazo) {
    const d = props[p.prazo.name]?.date;
    if (d?.start) task.prazo = d.start;
    if (d?.end) task.prazo_fim = d.end;
  }
  if (p.tempo) {
    const n = props[p.tempo.name]?.number;
    if (typeof n === "number") task.tempo_estimado_min = n;
  }
  if (p.tipo) {
    const raw = props[p.tipo.name]?.select?.name ?? "";
    if (raw) task.tipo = canonicalTipoFor(raw) ?? raw;
  }
  if (p.quem) {
    const s = richTextPlain(props[p.quem.name]);
    if (s) task.quem = capText(s);
  }
  if (p.origem) {
    const v = p.origem.kind === "url" ? props[p.origem.name]?.url : richTextPlain(props[p.origem.name]);
    if (v) task.origem_url = capText(String(v));
  }
  if (p.projeto) {
    if (p.projeto.kind === "multi_select") {
      const arr = props[p.projeto.name]?.multi_select;
      if (Array.isArray(arr) && arr.length) {
        task.projeto = capText(arr.map((o: any) => o?.name ?? "").filter(Boolean).join(", "));
      }
    } else {
      const v = props[p.projeto.name]?.select?.name;
      if (v) task.projeto = capText(String(v));
    }
  }
  if (p.criada_em) {
    const v = props[p.criada_em.name]?.created_time;
    if (v) task.criada_em = v;
  }
  if (p.concluida_em) {
    const v = props[p.concluida_em.name]?.date?.start;
    if (v) task.concluida_em = v;
  }
  return task;
}

// --- client-side filters / sort / board -----------------------------------------

/** PURE: enforce the option semantics regardless of what Notion's server filter
 *  could express for this schema (e.g. status options with no synonym). */
export function applyClientFilters(tasks: Task[], opts: ListTasksOptions): Task[] {
  let out = tasks;
  if (opts.status?.length) {
    // Canonicalize the REQUEST too: asking "To-do" or "A fazer" must match a
    // task whose status came back canonical ("todo").
    const wanted = new Set<string>();
    for (const s of opts.status) {
      wanted.add(normalize(s));
      const c = canonicalStatusFor(s);
      if (c) wanted.add(c);
    }
    out = out.filter((t) => {
      const c = canonicalStatusFor(String(t.status));
      return wanted.has(normalize(String(t.status))) || (c !== null && wanted.has(c));
    });
  } else if (!opts.incluir_concluidas) {
    out = out.filter((t) => !isClosedStatus(String(t.status)));
  }
  if (opts.prazo_de || opts.prazo_ate) {
    // Date-only compare on the prazo DAY: a datetime prazo
    // ("2026-06-11T15:00:00-03:00") still belongs to prazo_ate "2026-06-11".
    // The server-side date filter stays as a narrowing pre-pass.
    out = out.filter((t) => {
      if (!t.prazo) return false;
      const d = String(t.prazo).slice(0, 10);
      if (opts.prazo_de && d < opts.prazo_de) return false;
      if (opts.prazo_ate && d > opts.prazo_ate) return false;
      return true;
    });
  }
  return out;
}

/** PURE: prazo asc (no-prazo last), tie-break priority (urgente > ... > baixa). */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const da = a.prazo ?? "9999-99-99";
    const db = b.prazo ?? "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    const pa = priorityRank(a.prioridade ? String(a.prioridade) : undefined);
    const pb = priorityRank(b.prioridade ? String(b.prioridade) : undefined);
    if (pa !== pb) return pa - pb;
    return a.title.localeCompare(b.title);
  });
}

/** PURE: board summary over the returned task list. */
export function summarizeBoard(tasks: Task[], todayISO: string): TaskBoard {
  const by_status: Record<string, number> = {};
  let abertos = 0;
  let estimado = 0;
  let overdue = 0;
  for (const t of tasks) {
    const key = String(t.status || "(sem status)");
    by_status[key] = (by_status[key] ?? 0) + 1;
    if (!isClosedStatus(String(t.status))) {
      abertos += 1;
      if (typeof t.tempo_estimado_min === "number") estimado += t.tempo_estimado_min;
      if (t.prazo && t.prazo.slice(0, 10) < todayISO) overdue += 1;
    }
  }
  return { by_status, abertos, estimado_min: estimado, overdue_count: overdue };
}

export interface ListTasksResult {
  tasks: Task[];
  board: TaskBoard;
  tracker_url: string | null;
  /** True when the scan stopped at MAX_SCAN_ROWS with Notion still holding
   *  more pages — board counts (abertos/overdue) are then a FLOOR. */
  truncated: boolean;
}

/** Query the account's tracker and return canonical tasks + board summary.
 *  Follows has_more/next_cursor up to MAX_SCAN_ROWS so the board summarizes
 *  the WHOLE (filtered) base, not just the first page; `limit` only slices the
 *  returned tasks. NEVER creates anything (read path). On a 400 (cached
 *  profile drifted from the real schema) the profile is invalidated and the
 *  query retried once. */
export async function listTasks(
  accountId: string,
  opts: ListTasksOptions = {},
  deps: AdapterDeps = {},
): Promise<ListTasksResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let ctx = await loadTrackerProfile(accountId, deps);

  const query = (profile: TrackerProfile, token: string, cursor?: string) => {
    const body = buildListQuery(profile, opts);
    if (cursor) body.start_cursor = cursor;
    return rawNotionFetch(
      token,
      `/v1/data_sources/${profile.dataSourceId}/query`,
      { method: "POST", body: JSON.stringify(body) },
      fetchImpl,
    );
  };

  let r = await query(ctx.profile, ctx.token);
  if (!r.ok && r.status === 400) {
    invalidateTrackerProfile(accountId);
    ctx = await loadTrackerProfile(accountId, deps);
    r = await query(ctx.profile, ctx.token);
  }
  if (!r.ok) throw new Error(rawErrorMessage("query", r));

  const pages: any[] = Array.isArray(r.data?.results) ? r.data.results : [];
  let hasMore = !!r.data?.has_more;
  let cursor: string | null = r.data?.next_cursor ?? null;
  while (hasMore && cursor && pages.length < MAX_SCAN_ROWS) {
    const rn = await query(ctx.profile, ctx.token, cursor);
    if (!rn.ok) throw new Error(rawErrorMessage("query", rn));
    if (Array.isArray(rn.data?.results)) pages.push(...rn.data.results);
    hasMore = !!rn.data?.has_more;
    cursor = rn.data?.next_cursor ?? null;
  }
  const truncated = hasMore;

  // Client filters over the FULL accumulation; the board summarizes everything
  // that matched (before the limit slice), so abertos/overdue are real counts.
  const filtered = applyClientFilters(pages.map((p) => pageToTask(ctx.profile, p)), opts);
  const today = localDateInTz(DEFAULT_TIMEZONE, deps.now ?? new Date());
  const board = summarizeBoard(filtered, today);
  const tasks = sortTasks(filtered).slice(0, clampLimit(opts.limit));

  return { tasks, board, tracker_url: ctx.profile.url, truncated };
}

// --- briefing/brain_today bridge --------------------------------------------------

export interface TopTask {
  name: string;
  priority: string;
  due: string | null;
  tempo_estimado: number | null;
}

/** Top open tasks for ANY account in the BriefingTask shape used by the daily
 *  briefing and brain_today (due asc, no-due last, then priority). */
export async function getTopTasksForAccount(
  accountId: string,
  limit = 8,
  deps: AdapterDeps = {},
): Promise<TopTask[]> {
  const { tasks } = await listTasks(accountId, { limit: 50 }, deps);
  return tasks.slice(0, limit).map((t) => ({
    name: t.title,
    priority: t.prioridade ? String(t.prioridade) : "",
    due: t.prazo ? String(t.prazo).slice(0, 10) : null,
    tempo_estimado: typeof t.tempo_estimado_min === "number" ? t.tempo_estimado_min : null,
  }));
}
