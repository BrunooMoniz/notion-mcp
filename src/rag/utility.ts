// src/rag/utility.ts
// Spec 004 — utility scoring: weights, decay, clamp, boost formula.
// All functions are pure (no IO) and dependency-injectable for tests.

// ---------------------------------------------------------------------------
// Constants (all overridable via env)
// ---------------------------------------------------------------------------

/** Exponential decay factor per day (0.995/day ≈ -0.5% per day). */
export const DECAY_PER_DAY = 0.995;

/** Minimum utility score (clamp floor). */
export const UTILITY_MIN = -10;

/** Maximum utility score (clamp ceiling). */
export const UTILITY_MAX = 50;

/**
 * Default UTILITY_ALPHA: controls how strongly utility boosts the rerank score.
 * 0 = kill switch (ranking unchanged); 0.15 = max ±15%.
 * Override with env var UTILITY_ALPHA.
 */
export function getUtilityAlpha(): number {
  const v = Number(process.env.UTILITY_ALPHA);
  return Number.isFinite(v) ? v : 0.15;
}

// ---------------------------------------------------------------------------
// Signal weights (spec §2)
// ---------------------------------------------------------------------------

export const UTILITY_WEIGHTS = {
  user_thumb_up: 3.0,
  user_thumb_down: -3.0,
  assistant_useful: 1.5,
  assistant_useless: -1.5,
  implicit_cited: 0.3,
  implicit_action: 1.0,
} as const;

export type UtilitySignal = keyof typeof UTILITY_WEIGHTS;

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

/** Clamp a value to [UTILITY_MIN, UTILITY_MAX]. */
export function clampUtility(value: number): number {
  return Math.max(UTILITY_MIN, Math.min(UTILITY_MAX, value));
}

/**
 * Compute the effective (decayed) utility at read time.
 * Formula: score * DECAY^days_since_last_useful_at
 * When last_useful_at is null, no decay is applied (score returned as-is).
 *
 * @param score         Current materialized utility_score.
 * @param lastUsefulAt  Timestamp of last useful event (or null).
 * @param now           Injectable for tests; defaults to Date.now().
 */
export function computeEffectiveUtility(
  score: number,
  lastUsefulAt: Date | null,
  now: Date = new Date(),
): number {
  if (!lastUsefulAt) return score;
  const daysDelta = Math.max(0, (now.getTime() - lastUsefulAt.getTime()) / 86_400_000);
  return score * Math.pow(DECAY_PER_DAY, daysDelta);
}

/**
 * Apply a feedback delta to the current materialized utility_score, with lazy
 * decay up to the moment of writing.
 *
 * Formula: clamp(score * DECAY^days + delta, UTILITY_MIN, UTILITY_MAX)
 *
 * @param currentScore  Current value of brain_chunks.utility_score.
 * @param lastUsefulAt  Current value of brain_chunks.last_useful_at (or null).
 * @param delta         Signed delta to apply (from UTILITY_WEIGHTS).
 * @param now           Injectable for tests.
 */
export function applyDelta(
  currentScore: number,
  lastUsefulAt: Date | null,
  delta: number,
  now: Date = new Date(),
): number {
  const decayed = computeEffectiveUtility(currentScore, lastUsefulAt, now);
  return clampUtility(decayed + delta);
}

/**
 * Apply the utility boost to a reranker score.
 * Formula: final = rerank_score * (1 + alpha * tanh(effective_utility / 10))
 *
 * Kill switch: alpha=0 returns rerank_score byte-for-byte.
 * Bound: at alpha=0.15, max boost/penalty is ±15% of the rerank score.
 *
 * @param rerankScore     Score from the cross-encoder reranker.
 * @param effectiveUtility Decayed utility value from computeEffectiveUtility.
 * @param alpha           UTILITY_ALPHA (injectable; use getUtilityAlpha() at call site).
 */
export function applyFinalScore(
  rerankScore: number,
  effectiveUtility: number,
  alpha: number,
): number {
  if (alpha === 0) return rerankScore;
  return rerankScore * (1 + alpha * Math.tanh(effectiveUtility / 10));
}
