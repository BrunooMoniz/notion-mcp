// src/rag/status.ts
// Pure observability helpers (NO DB import) so they are unit-testable without a
// Postgres connection. The DB query (getStatus in storage.ts) is a thin shell
// around summarizeStatus(); recordRun writes the rows summarizeStatus reads.
//
// Why this exists: a dead source must never be silent again. The indexer and
// classifier append one status_runs row per source per run; /status and the
// stale-source alert read the LATEST row per (worker, source) so a token that
// quietly indexes 0, or a calendar feed that stopped, surfaces as stale/failing.

/**
 * Staleness threshold (seconds) for a source's last successful run.
 * Default 3h — the indexer cron runs hourly ("0 * * * *"), so >3h without a
 * run means ~3 consecutive missed ticks: a real outage, not a single blip.
 */
export const STALE_THRESHOLD_SECONDS = 3 * 60 * 60; // 10800s = 3h

/** Pure: is a source stale given its age and a threshold? Strict greater-than. */
export function staleness(
  ageSeconds: number,
  thresholdSeconds: number = STALE_THRESHOLD_SECONDS,
): boolean {
  return ageSeconds > thresholdSeconds;
}

/** Raw latest-row shape returned by getStatus's DB query (one per worker+source). */
export interface StatusRow {
  worker: string;
  source: string;
  ok: boolean;
  counts: unknown;
  error: string | null;
  last_run_at: Date;
  /** Best-effort merge of sync_state.last_sync_at for the mapped source (or null). */
  sync_last_at: Date | null;
}

/** /status payload entry — age/stale computed, dates serialized to ISO. */
export interface StatusSource {
  worker: string;
  source: string;
  ok: boolean;
  last_run_at: string;
  sync_last_at: string | null;
  age_seconds: number;
  stale: boolean;
  counts: unknown;
  error: string | null;
}

/**
 * Pure: map raw latest-rows to the /status payload, computing age_seconds and
 * stale relative to `now`. No DB, no I/O — fully unit-testable with fixtures.
 * Clock skew (last_run_at slightly ahead of now) clamps age to 0.
 */
export function summarizeStatus(
  rows: StatusRow[],
  now: Date = new Date(),
  thresholdSeconds: number = STALE_THRESHOLD_SECONDS,
): StatusSource[] {
  return rows.map((r) => {
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - r.last_run_at.getTime()) / 1000));
    return {
      worker: r.worker,
      source: r.source,
      ok: r.ok,
      last_run_at: r.last_run_at.toISOString(),
      sync_last_at: r.sync_last_at ? r.sync_last_at.toISOString() : null,
      age_seconds: ageSeconds,
      stale: staleness(ageSeconds, thresholdSeconds),
      counts: r.counts,
      error: r.error,
    };
  });
}
