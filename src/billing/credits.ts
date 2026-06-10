// src/billing/credits.ts
// F7 — Unified credit model.
// Pure functions: no DB, no env side-effects. Credits are a display + enforcement
// layer over usage_log; internally everything stays as individual metrics.
//
// Credit table (spec §2):
//   search          → 1 credit  (brain_search call)
//   ask             → 2 credits (portal /ask chat turn, search route)
//   action          → 2 credits (portal /ask/execute action)
//   index_pages     → 0.2 credits per page
//   (all other metrics, e.g. llm_input_tokens) → 0 credits (not billed as credits)
//
// monthlyCreditsUsed queries usage_log for the current month and converts each
// metric to credits. Injected pool seam for unit tests.

import { getPool, hasInjectedPool } from "../rag/storage.js";
import { monthStartUTC } from "./usage.js";

// ---------------------------------------------------------------------------
// Credit rates per metric (pure)
// ---------------------------------------------------------------------------

/** Credit cost table. Metrics not listed here contribute 0 credits. */
export const CREDIT_RATES: Record<string, number> = {
  search: 1,
  ask: 2,
  action: 2,
  index_pages: 0.2,
};

/**
 * Convert (metric, qty) to credits.
 * Pure — safe to call anywhere, no I/O.
 */
export function creditsFor(metric: string, qty: number): number {
  const rate = CREDIT_RATES[metric];
  if (rate === undefined || rate === 0) return 0;
  return rate * qty;
}

// ---------------------------------------------------------------------------
// Monthly credit usage query
// ---------------------------------------------------------------------------

/**
 * Sum of credits consumed by an account in the current calendar month (UTC).
 * Reads from usage_log, converts each row using creditsFor().
 * Returns 0 when there is no DB (unit tests without injected pool).
 */
export async function monthlyCreditsUsed(accountId: string): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const since = monthStartUTC();

  const { rows } = await p.query<{ metric: string; total: string }>(
    `SELECT metric, COALESCE(sum(qty), 0)::text AS total
       FROM usage_log
      WHERE account_id = $1 AND ts >= $2
   GROUP BY metric`,
    [accountId, since],
  );

  let total = 0;
  for (const row of rows) {
    const qty = Number(row.total);
    total += creditsFor(row.metric, qty);
  }
  return total;
}
