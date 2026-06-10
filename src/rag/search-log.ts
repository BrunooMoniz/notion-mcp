// src/rag/search-log.ts
// 002-app-v2 — AI search transparency log ("O que sua IA buscou"). Every
// in-request brainSearch appends one row to ai_search_log so the account owner
// can see what their connected assistants searched. Best-effort, mirroring
// recordUsage: a logging failure must NEVER break the real search path, so it
// swallows errors and no-ops when there's no DB (unit tests / light dev).

const MAX_QUERY_CHARS = 300;

/** Append one search event for an account. Best-effort: truncates the query to
 *  300 chars, swallows every error, and no-ops without a pool (same pattern as
 *  recordUsage). `client` is the human label of who searched (token label,
 *  "Claude.ai", "Consultar"...). */
export async function recordSearchEvent(
  accountId: string,
  query: string,
  results: number,
  client?: string,
): Promise<void> {
  try {
    // Lazy import (same as usage.ts) so importing this module never pulls the
    // pool at module-init time.
    const { getPool, hasInjectedPool } = await import("./storage.js");
    // No-op when there's no real DB and no injected test pool — avoids a
    // pointless failed connection in unit tests that don't exercise the log.
    if (!process.env.POSTGRES_URL && !hasInjectedPool()) return;
    const p = getPool();
    await p.query(
      `INSERT INTO ai_search_log (account_id, query, results, client) VALUES ($1, $2, $3, $4)`,
      [accountId, query.slice(0, MAX_QUERY_CHARS), Math.max(0, Math.floor(results)), client ?? null],
    );
  } catch (err: any) {
    console.warn(`[search-log] recordSearchEvent failed (log only): ${err?.message ?? err}`);
  }
}

export interface SearchLogEntry {
  query: string;
  results: number;
  client: string | null;
  ts: string; // ISO-8601
}

/** Last searches for ONE account: 7-day window, newest first, capped at 50.
 *  Powers GET /portal/ai-searches; account_id always comes from the session. */
export async function listSearchEvents(
  accountId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<SearchLogEntry[]> {
  const days = opts.days ?? 7;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
  const { getPool } = await import("./storage.js");
  const p = getPool();
  const { rows } = await p.query<{
    query: string;
    results: number;
    client: string | null;
    ts: Date;
  }>(
    `SELECT query, results, client, ts
       FROM ai_search_log
      WHERE account_id = $1 AND ts >= now() - ($2 || ' days')::interval
      ORDER BY ts DESC
      LIMIT $3`,
    [accountId, String(days), limit],
  );
  return rows.map((r) => ({
    query: r.query,
    results: Number(r.results),
    client: r.client,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
  }));
}
