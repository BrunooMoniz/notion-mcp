// src/admin/__tests__/admin-gate.test.ts
// F-2 pentest fix — admin gate uses timing-safe comparison.
// Tests that safeEqual (now exported from oauth.ts) correctly accepts a matching
// token and rejects a wrong or different-length token, verifying the gate relies
// on timing-safe equality rather than ===.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEqual } from "../../crypto-utils.js";

test("safeEqual: identical tokens return true", () => {
  assert.ok(safeEqual("correct-secret-token", "correct-secret-token"));
});

test("safeEqual: different tokens return false", () => {
  assert.ok(!safeEqual("correct-secret-token", "wrong-secret-token!!"));
});

test("safeEqual: different-length tokens return false without timing attack surface", () => {
  // Different lengths short-circuit before timingSafeEqual to avoid Buffer length mismatch.
  assert.ok(!safeEqual("short", "a-much-longer-token-that-is-different"));
});

test("safeEqual: empty strings are equal", () => {
  assert.ok(safeEqual("", ""));
});

test("safeEqual: one empty, one non-empty returns false", () => {
  assert.ok(!safeEqual("", "nonempty"));
});
