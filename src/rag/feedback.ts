// src/rag/feedback.ts
// Spec 004 — feedback storage: apply a utility delta to a chunk, write the audit log.
// Enforces account-scoped access: cross-account access returns "not_found".

import { getPool } from "./storage.js";
import { applyDelta } from "./utility.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeedbackSource =
  | "user_thumb"
  | "assistant"
  | "implicit_cited"
  | "implicit_action";

export interface ApplyFeedbackInput {
  accountId: string;
  chunkId: string;
  source: FeedbackSource;
  /** Signed delta (from UTILITY_WEIGHTS). */
  delta: number;
  /** The originating query (truncated to 300 chars). */
  query?: string;
}

export interface ApplyFeedbackResult {
  status: "updated" | "not_found";
  newScore?: number;
  newFeedbackCount?: number;
}

// ---------------------------------------------------------------------------
// PoolLike interface (same pattern as storage.ts — injectable for tests)
// ---------------------------------------------------------------------------

type PoolLike = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
};

// ---------------------------------------------------------------------------
// applyFeedback
// ---------------------------------------------------------------------------

/**
 * Apply a utility delta to a chunk, enforcing account scope.
 * Writes the audit row to chunk_feedback AFTER the UPDATE succeeds.
 *
 * Security: cross-account access (chunk.account_id !== accountId) returns
 * {status: "not_found"} — indistinguishable from a missing chunk for callers.
 *
 * @param input  Feedback parameters.
 * @param pool   Optional pool override (test injection; defaults to getPool()).
 * @param now    Injectable timestamp (test injection; defaults to new Date()).
 */
export async function applyFeedback(
  input: ApplyFeedbackInput,
  pool: PoolLike = getPool(),
  now: Date = new Date(),
): Promise<ApplyFeedbackResult> {
  const { accountId, chunkId, source, delta, query } = input;

  // Fetch the chunk to verify ownership and get current score.
  const selectResult = await pool.query(
    `SELECT account_id, utility_score, feedback_count, last_useful_at
     FROM brain_chunks
     WHERE id = $1`,
    [chunkId],
  );

  if (selectResult.rows.length === 0) {
    return { status: "not_found" };
  }

  const row = selectResult.rows[0] as {
    account_id: string;
    utility_score: number;
    feedback_count: number;
    last_useful_at: Date | null;
  };

  // Cross-account guard: chunk must belong to the requesting account.
  if (row.account_id !== accountId) {
    return { status: "not_found" };
  }

  // Apply lazy decay + delta.
  const newScore = applyDelta(row.utility_score, row.last_useful_at, delta, now);
  const newFeedbackCount = row.feedback_count + 1;
  // Update last_useful_at only when the delta is positive (useful signal).
  const newLastUsefulAt = delta > 0 ? now : row.last_useful_at;

  // Update the chunk row.
  await pool.query(
    `UPDATE brain_chunks
     SET utility_score = $1,
         feedback_count = $2,
         last_useful_at = $3
     WHERE id = $4`,
    [newScore, newFeedbackCount, newLastUsefulAt, chunkId],
  );

  // Write the audit row (best-effort; failure here should not roll back the UPDATE).
  const truncatedQuery = query ? query.slice(0, 300) : null;
  await pool.query(
    `INSERT INTO chunk_feedback (account_id, chunk_id, source, value, query)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, chunkId, source, delta, truncatedQuery],
  );

  return { status: "updated", newScore, newFeedbackCount };
}
