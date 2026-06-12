// src/portal/activity-status.ts
// E2.1 — pure computation of the enriched "Por fonte" list for /portal/status.
// Takes credential inventory + status_runs (both already fetched by the caller)
// and returns one entry per configured source with:
//   - display_name: human-readable (workspace name, not ID)
//   - estado: enum ∈ { aguardando_primeira_indexacao | indexando | ok | erro | indisponivel_no_plano | pulado_sem_credencial }
//   - counts, last_run, error (truncated to 200 chars)
//
// Pure: no DB, no I/O, fully unit-testable. The route handler in routes.ts does
// the I/O and injects the inputs.

import type { StatusSource } from "../rag/status.js";

/** State enum surfaced to the frontend (matches design spec, E2.1). */
export type ActivityState =
  | "aguardando_primeira_indexacao"
  | "indexando"
  | "ok"
  | "erro"
  | "indisponivel_no_plano"
  | "pulado_sem_credencial";

/** One entry in the enriched sources list. */
export interface ActivitySource {
  /** Canonical source key (e.g. "notion-<ws>", "granola-friend", "calendar", "gcal:<email>"). */
  source: string;
  /** Source family: notion | granola | calendar | gcal */
  source_type: "notion" | "granola" | "calendar" | "gcal";
  /** Human-readable name (workspace name, account email, link label, etc.). */
  display_name: string;
  /** Machine-readable state. */
  estado: ActivityState;
  /** Last indexed counts blob (from status_runs). Null if no run yet. */
  counts: unknown;
  /** ISO timestamp of the last run. Null if no run yet. */
  last_run: string | null;
  /** Truncated error message (max 200 chars). Null when estado !== "erro". */
  error: string | null;
  /** Live indexed documents for THIS source (from brain_chunks). Null when unknown. */
  documents: number | null;
  /** Live indexed chunks for THIS source (from brain_chunks). Null when unknown. */
  chunks: number | null;
  /** Bug #96 (3): true when the last run hit (or was skipped by) the plan's
   *  chunk cap — the frontend renders the "faça upgrade" chip from this. */
  plan_limit: boolean;
}

/** Live per-source counts, keyed by the same source key used in the entries
 *  (notion-<ws> | granola | calendar | gcal:<email>). */
export interface LiveCountsEntry {
  documents: number;
  chunks: number;
}

// ---------- input shapes (caller provides these) ----------------------------

export interface NotionWorkspaceInput {
  workspace: string; // Notion workspace id
  name: string | null;
  /** Whether the workspace has a Notion credential in the vault
   *  (notion_pat:<ws> or notion_access:<ws>). Workspaces registered only as a
   *  bearer-scope tag for Granola/iCal (e.g. the synthetic FRIEND_WORKSPACE)
   *  have none and must NOT appear as a Notion source. Absent = true (compat). */
  hasCredential?: boolean;
}

export interface IcalLinkInput {
  id: string;
  label: string;
}

export interface GoogleAccountInput {
  email: string; // masked or real — used as display name
}

export interface ActivityCredentials {
  /** Notion workspaces connected (may be empty). */
  notionWorkspaces: NotionWorkspaceInput[];
  /** Whether a Granola key is configured. */
  hasGranola: boolean;
  /** iCal links configured (may be empty). */
  icalLinks: IcalLinkInput[];
  /** Google OAuth accounts connected (may be empty). */
  googleAccounts: GoogleAccountInput[];
}

// ---------- helpers ----------------------------------------------------------

/** Resolve ActivityState from a StatusSource (or null if no run exists).
 *  When a reindex is in flight, a source whose run already FINISHED inside this
 *  reindex (last_run >= runningSince) shows its real result instead of a
 *  blanket "indexando" — that's what makes per-source progress honest. */
function stateFromRun(
  run: StatusSource | null | undefined,
  isRunning: boolean,
  runningSince?: Date | null,
): ActivityState {
  const finishedThisRun =
    isRunning &&
    runningSince != null &&
    run?.last_run_at != null &&
    new Date(run.last_run_at).getTime() >= runningSince.getTime();
  if (isRunning && !finishedThisRun) return "indexando";
  if (!run) return "aguardando_primeira_indexacao";
  const counts = run.counts as Record<string, unknown> | null | undefined;
  if (counts && typeof counts === "object") {
    const skipped = counts.skipped;
    if (skipped === "plan_gate" || skipped === "plan_limit") return "indisponivel_no_plano";
    if (skipped === "no_credentials") return "pulado_sem_credencial";
  }
  // Bug #96 (3): the source that hit the chunk cap is a plan condition, not a
  // sync error — "erro" would prompt "corrigir" when the fix is an upgrade.
  if (!run.ok && run.error === "plan_limit") return "indisponivel_no_plano";
  return run.ok ? "ok" : "erro";
}

/** Bug #96 (3): the run hit the plan's chunk cap (error="plan_limit") or was
 *  skipped because a previous source did (counts.skipped="plan_limit"). */
function isPlanLimitRun(run: StatusSource | null | undefined): boolean {
  if (!run) return false;
  if (run.error === "plan_limit") return true;
  const counts = run.counts as Record<string, unknown> | null | undefined;
  return counts != null && typeof counts === "object" && counts.skipped === "plan_limit";
}

function truncateError(msg: string | null | undefined, max = 200): string | null {
  if (!msg) return null;
  return msg.length > max ? msg.slice(0, max) + "…" : msg;
}

// ---------- main export ------------------------------------------------------

/**
 * Compute the enriched activity source list.
 *
 * @param credentials  Credential inventory (from vault + account_workspaces).
 * @param runs         Latest status_run per source (from summarizeStatus/getStatus).
 * @param running      Whether a reindex is currently in-flight for this account.
 * @param opts.liveCounts    Live per-source counts from brain_chunks, keyed by
 *                           the same source key as each entry.
 * @param opts.runningSince  When the in-flight reindex started — lets a source
 *                           that already finished inside this run show "ok"
 *                           instead of "indexando".
 */
export function buildActivitySources(
  credentials: ActivityCredentials,
  runs: StatusSource[],
  running: boolean,
  opts: {
    liveCounts?: Map<string, LiveCountsEntry>;
    runningSince?: Date | null;
  } = {},
): ActivitySource[] {
  // Index runs by source key for O(1) lookup.
  const runMap = new Map<string, StatusSource>();
  for (const r of runs) {
    runMap.set(r.source, r);
  }
  const runningSince = opts.runningSince ?? null;
  const live = (key: string): LiveCountsEntry | null => opts.liveCounts?.get(key) ?? null;

  const out: ActivitySource[] = [];

  // ---- Notion workspaces ----
  for (const ws of credentials.notionWorkspaces) {
    // Bug #96 (1): skip credential-less workspaces (synthetic Granola/iCal scope
    // tags) — they are not Notion sources and would show a ghost
    // "aguardando_primeira_indexacao" entry forever.
    if (ws.hasCredential === false) continue;
    const sourceKey = `notion-${ws.workspace}`;
    const run = runMap.get(sourceKey) ?? null;
    const estado = stateFromRun(run, running, runningSince);
    const lv = live(sourceKey);
    out.push({
      source: sourceKey,
      source_type: "notion",
      display_name: ws.name || ws.workspace,
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
      documents: lv?.documents ?? null,
      chunks: lv?.chunks ?? null,
      plan_limit: isPlanLimitRun(run),
    });
  }

  // ---- Granola ----
  if (credentials.hasGranola) {
    // The source key used by index-account is "granola-<FRIEND_WORKSPACE>" but
    // we treat any "granola-*" run as the granola run for this account.
    const run =
      [...runMap.entries()].find(([k]) => k.startsWith("granola"))?.[1] ?? null;
    const estado = stateFromRun(run, running, runningSince);
    const lv = live("granola");
    out.push({
      source: run?.source ?? "granola-friend",
      source_type: "granola",
      display_name: "Granola",
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
      documents: lv?.documents ?? null,
      chunks: lv?.chunks ?? null,
      plan_limit: isPlanLimitRun(run),
    });
  }

  // ---- iCal links ----
  if (credentials.icalLinks.length > 0) {
    const run = runMap.get("calendar") ?? null;
    const estado = stateFromRun(run, running, runningSince);
    // Label the entry with the first link's label (or count when multiple).
    const label =
      credentials.icalLinks.length === 1
        ? credentials.icalLinks[0].label || "Calendário iCal"
        : `Calendários iCal (${credentials.icalLinks.length})`;
    const lv = live("calendar");
    out.push({
      source: "calendar",
      source_type: "calendar",
      display_name: label,
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
      documents: lv?.documents ?? null,
      chunks: lv?.chunks ?? null,
      plan_limit: isPlanLimitRun(run),
    });
  }

  // ---- Google Calendar OAuth ----
  // One entry PER connected account. They share a single "gcal" run record
  // (the pass indexes all accounts together), but each gets its own live
  // counts via the gcal:<email> key.
  const gcalRun = runMap.get("gcal") ?? null;
  for (const acct of credentials.googleAccounts) {
    const estado = stateFromRun(gcalRun, running, runningSince);
    const lv = acct.email ? live(`gcal:${acct.email}`) : null;
    out.push({
      source: acct.email ? `gcal:${acct.email}` : "gcal",
      source_type: "gcal",
      display_name: acct.email || "Google Calendar",
      estado,
      counts: gcalRun?.counts ?? null,
      last_run: gcalRun?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(gcalRun?.error) : null,
      documents: lv?.documents ?? null,
      chunks: lv?.chunks ?? null,
      plan_limit: isPlanLimitRun(gcalRun),
    });
  }

  return out;
}
