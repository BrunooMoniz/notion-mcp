// src/rag/__tests__/utility.test.ts
// TDD spec 004 — utility score, decay, feedback application, cross-account guard
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEffectiveUtility,
  applyDelta,
  applyFinalScore,
  clampUtility,
  UTILITY_WEIGHTS,
  DECAY_PER_DAY,
  UTILITY_MIN,
  UTILITY_MAX,
} from "../utility.js";

// --------------------------------------------------------------------------
// clampUtility
// --------------------------------------------------------------------------

test("clampUtility returns value within [-10, +50]", () => {
  assert.equal(clampUtility(0), 0);
  assert.equal(clampUtility(60), UTILITY_MAX);   // above max -> max
  assert.equal(clampUtility(-20), UTILITY_MIN);  // below min -> min
  assert.equal(clampUtility(50), UTILITY_MAX);
  assert.equal(clampUtility(-10), UTILITY_MIN);
});

// --------------------------------------------------------------------------
// computeEffectiveUtility — lazy decay
// --------------------------------------------------------------------------

test("computeEffectiveUtility: no last_useful_at → score unchanged", () => {
  const eff = computeEffectiveUtility(5, null);
  assert.equal(eff, 5);
});

test("computeEffectiveUtility: 0 days → score unchanged (decay^0 = 1)", () => {
  const now = new Date();
  const eff = computeEffectiveUtility(6, now);
  // DECAY^0 = 1, should equal score
  assert.ok(Math.abs(eff - 6) < 0.001);
});

test("computeEffectiveUtility: decay over many days reduces score", () => {
  const lastAt = new Date(Date.now() - 100 * 86400 * 1000); // 100 days ago
  const score = 10;
  const eff = computeEffectiveUtility(score, lastAt);
  const expected = score * Math.pow(DECAY_PER_DAY, 100);
  assert.ok(Math.abs(eff - expected) < 0.01, `expected ~${expected}, got ${eff}`);
  assert.ok(eff < score, "decay should reduce score over time");
});

// --------------------------------------------------------------------------
// applyDelta — utility_score = clamp(score * DECAY^days + delta, -10, +50)
// --------------------------------------------------------------------------

test("applyDelta: 👍 👍 👎 with 0-day decay = 3+3-3 = 3.0", () => {
  const now = new Date();
  // Apply three deltas sequentially with 0 decay (same timestamp)
  let s = 0;
  s = applyDelta(s, now, UTILITY_WEIGHTS.user_thumb_up, now);
  s = applyDelta(s, now, UTILITY_WEIGHTS.user_thumb_up, now);
  s = applyDelta(s, now, UTILITY_WEIGHTS.user_thumb_down, now);
  // 0 * DECAY^0 + 3 = 3 -> 3 * DECAY^0 + 3 = 6 -> 6 * DECAY^0 - 3 = 3
  assert.ok(Math.abs(s - 3.0) < 0.001, `expected 3.0, got ${s}`);
});

test("applyDelta: clamps above max (+50)", () => {
  const now = new Date();
  const result = applyDelta(49, now, 5, now);
  assert.equal(result, UTILITY_MAX);
});

test("applyDelta: clamps below min (-10)", () => {
  const now = new Date();
  const result = applyDelta(-9, now, -5, now);
  assert.equal(result, UTILITY_MIN);
});

// --------------------------------------------------------------------------
// UTILITY_WEIGHTS
// --------------------------------------------------------------------------

test("UTILITY_WEIGHTS has all required signal keys", () => {
  assert.ok(typeof UTILITY_WEIGHTS.user_thumb_up === "number");
  assert.ok(typeof UTILITY_WEIGHTS.user_thumb_down === "number");
  assert.ok(typeof UTILITY_WEIGHTS.assistant_useful === "number");
  assert.ok(typeof UTILITY_WEIGHTS.assistant_useless === "number");
  assert.ok(typeof UTILITY_WEIGHTS.implicit_cited === "number");
  assert.ok(typeof UTILITY_WEIGHTS.implicit_action === "number");
});

test("UTILITY_WEIGHTS values match spec", () => {
  assert.equal(UTILITY_WEIGHTS.user_thumb_up, 3.0);
  assert.equal(UTILITY_WEIGHTS.user_thumb_down, -3.0);
  assert.equal(UTILITY_WEIGHTS.assistant_useful, 1.5);
  assert.equal(UTILITY_WEIGHTS.assistant_useless, -1.5);
  assert.equal(UTILITY_WEIGHTS.implicit_cited, 0.3);
  assert.equal(UTILITY_WEIGHTS.implicit_action, 1.0);
});

// --------------------------------------------------------------------------
// applyFinalScore (boost formula)
// --------------------------------------------------------------------------

test("applyFinalScore: alpha=0 returns rerank_score unchanged (byte-for-byte kill switch)", () => {
  const rerankScore = 0.72;
  const effUtility = 8;
  const result = applyFinalScore(rerankScore, effUtility, 0);
  assert.equal(result, rerankScore);
});

test("applyFinalScore: positive utility boosts score, negative reduces it", () => {
  const base = 0.5;
  const boosted = applyFinalScore(base, 10, 0.15);
  const penalized = applyFinalScore(base, -10, 0.15);
  assert.ok(boosted > base, "positive utility should boost");
  assert.ok(penalized < base, "negative utility should penalize");
});

test("applyFinalScore: boost is bounded (max ~±15% with alpha=0.15)", () => {
  // tanh approaches 1 for large x → max boost = 1 * 0.15 = 15% of base
  const base = 0.5;
  const maxBoosted = applyFinalScore(base, 1000, 0.15); // very high utility
  const maxPenalized = applyFinalScore(base, -1000, 0.15); // very low utility
  // at tanh(100) ≈ 1: final = base * (1 + 0.15*1) = base * 1.15
  assert.ok(maxBoosted <= base * 1.15 + 0.001);
  // at tanh(-100) ≈ -1: final = base * (1 - 0.15) = base * 0.85
  assert.ok(maxPenalized >= base * 0.85 - 0.001);
});
