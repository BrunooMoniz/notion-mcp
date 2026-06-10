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
  /** Canonical source key (e.g. "notion-<ws>", "granola-friend", "calendar", "gcal"). */
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
}

// ---------- input shapes (caller provides these) ----------------------------

export interface NotionWorkspaceInput {
  workspace: string; // Notion workspace id
  name: string | null;
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

/** Resolve ActivityState from a StatusSource (or null if no run exists). */
function stateFromRun(
  run: StatusSource | null | undefined,
  isRunning: boolean,
): ActivityState {
  if (isRunning) return "indexando";
  if (!run) return "aguardando_primeira_indexacao";
  const counts = run.counts as Record<string, unknown> | null | undefined;
  if (counts && typeof counts === "object") {
    const skipped = counts.skipped;
    if (skipped === "plan_gate") return "indisponivel_no_plano";
    if (skipped === "no_credentials") return "pulado_sem_credencial";
  }
  return run.ok ? "ok" : "erro";
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
 */
export function buildActivitySources(
  credentials: ActivityCredentials,
  runs: StatusSource[],
  running: boolean,
): ActivitySource[] {
  // Index runs by source key for O(1) lookup.
  const runMap = new Map<string, StatusSource>();
  for (const r of runs) {
    runMap.set(r.source, r);
  }

  const out: ActivitySource[] = [];

  // ---- Notion workspaces ----
  for (const ws of credentials.notionWorkspaces) {
    const sourceKey = `notion-${ws.workspace}`;
    const run = runMap.get(sourceKey) ?? null;
    const estado = stateFromRun(run, running);
    out.push({
      source: sourceKey,
      source_type: "notion",
      display_name: ws.name || ws.workspace,
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
    });
  }

  // ---- Granola ----
  if (credentials.hasGranola) {
    // The source key used by index-account is "granola-<FRIEND_WORKSPACE>" but
    // we treat any "granola-*" run as the granola run for this account.
    const run =
      [...runMap.entries()].find(([k]) => k.startsWith("granola"))?.[1] ?? null;
    const estado = stateFromRun(run, running);
    out.push({
      source: run?.source ?? "granola-friend",
      source_type: "granola",
      display_name: "Granola",
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
    });
  }

  // ---- iCal links ----
  if (credentials.icalLinks.length > 0) {
    const run = runMap.get("calendar") ?? null;
    const estado = stateFromRun(run, running);
    // Label the entry with the first link's label (or count when multiple).
    const label =
      credentials.icalLinks.length === 1
        ? credentials.icalLinks[0].label || "Calendário iCal"
        : `Calendários iCal (${credentials.icalLinks.length})`;
    out.push({
      source: "calendar",
      source_type: "calendar",
      display_name: label,
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
    });
  }

  // ---- Google Calendar OAuth ----
  for (const acct of credentials.googleAccounts) {
    const run = runMap.get("gcal") ?? null;
    const estado = stateFromRun(run, running);
    out.push({
      source: "gcal",
      source_type: "gcal",
      display_name: acct.email || "Google Calendar",
      estado,
      counts: run?.counts ?? null,
      last_run: run?.last_run_at ?? null,
      error: estado === "erro" ? truncateError(run?.error) : null,
    });
    // Only one gcal entry even if multiple accounts share the same run record.
    break;
  }

  return out;
}
