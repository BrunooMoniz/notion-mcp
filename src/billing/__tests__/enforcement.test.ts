// src/billing/__tests__/enforcement.test.ts
// F7 — Tests for the 3-mode credit enforcement (off/soft/hard).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  QuotaExceededError,
  assertCreditsWithinLimit,
  getEnforcementMode,
} from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

// ---------------------------------------------------------------------------
// Fake pool factory
// ---------------------------------------------------------------------------

function memPool(plan: string, usageRows: { metric: string; total: string }[]) {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      // monthlyCreditsUsed: GROUP BY metric query
      if (/GROUP BY metric/i.test(sql)) return { rows: usageRows };
      return { rows: [] };
    },
  };
}

beforeEach(() => { __clearPlanCache(); delete process.env.PLAN_ENFORCEMENT; });
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); delete process.env.PLAN_ENFORCEMENT; });

// ---------------------------------------------------------------------------
// getEnforcementMode
// ---------------------------------------------------------------------------

test("getEnforcementMode defaults to soft", () => {
  delete process.env.PLAN_ENFORCEMENT;
  assert.equal(getEnforcementMode(), "soft");
});

test("getEnforcementMode respects env var", () => {
  process.env.PLAN_ENFORCEMENT = "off";
  assert.equal(getEnforcementMode(), "off");
  process.env.PLAN_ENFORCEMENT = "hard";
  assert.equal(getEnforcementMode(), "hard");
  process.env.PLAN_ENFORCEMENT = "soft";
  assert.equal(getEnforcementMode(), "soft");
  // Unknown value falls back to soft
  process.env.PLAN_ENFORCEMENT = "bogus";
  assert.equal(getEnforcementMode(), "soft");
});

// ---------------------------------------------------------------------------
// Mode: off — no check at all
// ---------------------------------------------------------------------------

test("mode=off: does not check credits even when exhausted", async () => {
  process.env.PLAN_ENFORCEMENT = "off";
  // Pool would throw if queried — but it shouldn't be queried in off mode.
  __setPoolForTest({ query: async () => { throw new Error("must not query DB in off mode"); } } as never);
  // Should NOT throw.
  await assertCreditsWithinLimit("friend:1", "search", 9999);
});

// ---------------------------------------------------------------------------
// Mode: soft — allows but logs
// ---------------------------------------------------------------------------

test("mode=soft: allows when within limit", async () => {
  process.env.PLAN_ENFORCEMENT = "soft";
  // Free plan: 100 credits/month. Used: 50 searches (50 credits). Cost: 1.
  __setPoolForTest(memPool("free", [{ metric: "search", total: "50" }]) as never);
  // Should NOT throw.
  await assertCreditsWithinLimit("friend:1", "search", 1);
});

test("mode=soft: allows even when OVER limit (never blocks)", async () => {
  process.env.PLAN_ENFORCEMENT = "soft";
  // Free plan: 100 credits. Used: 120 searches (120 credits). Way over.
  __setPoolForTest(memPool("free", [{ metric: "search", total: "120" }]) as never);
  // Must NOT throw — soft mode never blocks.
  await assertCreditsWithinLimit("friend:1", "search", 1);
});

// ---------------------------------------------------------------------------
// Mode: hard — blocks when exhausted
// ---------------------------------------------------------------------------

test("mode=hard: allows when within limit", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  // Free plan: 100 credits. Used: 50.
  __setPoolForTest(memPool("free", [{ metric: "search", total: "50" }]) as never);
  // Should NOT throw.
  await assertCreditsWithinLimit("friend:1", "search", 1);
});

test("mode=hard: blocks when credits exhausted", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  // Free plan: 100 credits. Used: 100 searches = 100 credits.
  __setPoolForTest(memPool("free", [{ metric: "search", total: "100" }]) as never);
  await assert.rejects(
    () => assertCreditsWithinLimit("friend:1", "search", 1),
    (e: any) => {
      assert.ok(e instanceof QuotaExceededError);
      return true;
    },
  );
});

test("mode=hard: blocks with mixed metric usage", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  // Free plan: 100 credits. Used: 40 searches (40) + 30 ask (60) = 100 total.
  __setPoolForTest(memPool("free", [
    { metric: "search", total: "40" },
    { metric: "ask", total: "30" },
  ]) as never);
  await assert.rejects(
    () => assertCreditsWithinLimit("friend:1", "ask", 2),
    QuotaExceededError,
  );
});

// ---------------------------------------------------------------------------
// ilimitado plan: never hard-blocked (soft-only)
// ---------------------------------------------------------------------------

test("mode=hard, ilimitado plan: soft-alert only, never throws", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  // ilimitado: 30_000 credits soft cap. Way over.
  __setPoolForTest(memPool("ilimitado", [{ metric: "search", total: "40000" }]) as never);
  // Must NOT throw even in hard mode for ilimitado.
  await assertCreditsWithinLimit("friend:ilimitado", "search", 1);
});

// ---------------------------------------------------------------------------
// owner plan / DEFAULT_ACCOUNT_ID: always exempt
// ---------------------------------------------------------------------------

test("owner account (bruno) is never checked regardless of mode", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  __setPoolForTest({ query: async () => { throw new Error("must not query DB for owner"); } } as never);
  // DEFAULT_ACCOUNT_ID = 'bruno'
  await assertCreditsWithinLimit("bruno", "search", 9999);
});

test("mode=hard, owner plan: never blocked", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  __setPoolForTest(memPool("owner", [{ metric: "search", total: "999999" }]) as never);
  await assertCreditsWithinLimit("friend:owner", "search", 9999);
});

// ---------------------------------------------------------------------------
// Essencial plan limits
// ---------------------------------------------------------------------------

test("mode=hard, essencial: allows when under 1500 credits", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  // 700 searches = 700 credits, cost=1 → total 701 < 1500.
  __setPoolForTest(memPool("essencial", [{ metric: "search", total: "700" }]) as never);
  await assertCreditsWithinLimit("friend:e", "search", 1);
});

test("mode=hard, essencial: blocks at 1500", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  __setPoolForTest(memPool("essencial", [{ metric: "search", total: "1500" }]) as never);
  await assert.rejects(
    () => assertCreditsWithinLimit("friend:e", "search", 1),
    QuotaExceededError,
  );
});

// ---------------------------------------------------------------------------
// Pro plan limits
// ---------------------------------------------------------------------------

test("mode=hard, pro: allows under 8000 credits", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  __setPoolForTest(memPool("pro", [{ metric: "search", total: "7999" }]) as never);
  await assertCreditsWithinLimit("friend:p", "search", 1);
});

test("mode=hard, pro: blocks at 8000", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  __setPoolForTest(memPool("pro", [{ metric: "search", total: "8000" }]) as never);
  await assert.rejects(
    () => assertCreditsWithinLimit("friend:p", "search", 1),
    QuotaExceededError,
  );
});
