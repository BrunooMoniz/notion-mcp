// src/billing/__tests__/usage.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  QuotaExceededError,
  monthStartUTC,
  dayStartUTC,
  queryUsage,
  countChunks,
  getUsageSnapshot,
  assertSearchWithinLimit,
  assertChunksWithinLimit,
  assertOnDemandWithinLimit,
} from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

// Tunable fakes the memPool reads.
let plan = "free";
let searchSum = 0;
let indexPagesSum = 0;
let chunkCount = 0;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/sum\(qty\)/i.test(sql)) {
        const metric = params[1];
        const total = metric === "search" ? searchSum : metric === "index_pages" ? indexPagesSum : 0;
        return { rows: [{ total: String(total) }] };
      }
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) return { rows: [{ n: String(chunkCount) }] };
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  plan = "free"; searchSum = 0; indexPagesSum = 0; chunkCount = 0;
  __setPoolForTest(memPool() as never);
  __clearPlanCache();
});
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("monthStartUTC/dayStartUTC truncate to UTC boundaries", () => {
  const now = new Date("2026-06-17T13:45:00Z");
  assert.equal(monthStartUTC(now).toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(dayStartUTC(now).toISOString(), "2026-06-17T00:00:00.000Z");
});

test("queryUsage / countChunks read sums", async () => {
  searchSum = 42; chunkCount = 7;
  assert.equal(await queryUsage("friend:1", "search", monthStartUTC()), 42);
  assert.equal(await countChunks("friend:1"), 7);
});

test("owner account ('bruno' = DEFAULT_ACCOUNT_ID) is never limited", async () => {
  searchSum = 1_000_000; chunkCount = 1_000_000;
  await assertSearchWithinLimit("bruno");           // no throw
  await assertChunksWithinLimit("bruno", 999_999);  // no throw
  await assertOnDemandWithinLimit("bruno", 999);    // no throw
});

test("owner PLAN ('owner') is never limited even with a friend-shaped id", async () => {
  plan = "owner"; searchSum = 1_000_000; chunkCount = 1_000_000;
  await assertSearchWithinLimit("friend:op");
  await assertChunksWithinLimit("friend:op", 999_999);
});

test("free: searches blocked at/over monthly cap (100)", async () => {
  searchSum = 99; await assertSearchWithinLimit("friend:1"); // 99 < 100 ok
  searchSum = 100;
  await assert.rejects(() => assertSearchWithinLimit("friend:1"), (e: any) => {
    assert.ok(e instanceof QuotaExceededError);
    assert.equal(e.limit, 100); assert.equal(e.used, 100);
    return true;
  });
});

test("free: chunk cap (2000) blocks when current+incoming would exceed", async () => {
  chunkCount = 1990; await assertChunksWithinLimit("friend:1", 10); // 2000 == cap ok
  chunkCount = 1990;
  await assert.rejects(() => assertChunksWithinLimit("friend:1", 11), QuotaExceededError);
});

test("free: on-demand indexing not included -> always blocked", async () => {
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 1), QuotaExceededError);
});

test("essencial: on-demand daily cap (50)", async () => {
  plan = "essencial";
  indexPagesSum = 40; await assertOnDemandWithinLimit("friend:1", 10); // 50 ok
  indexPagesSum = 45;
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 10), QuotaExceededError);
});

test("getUsageSnapshot reports used+limit per metric", async () => {
  plan = "pro"; chunkCount = 100; searchSum = 5; indexPagesSum = 2;
  const snap = await getUsageSnapshot("friend:1");
  assert.equal(snap.plan, "pro");
  assert.deepEqual(snap.chunks, { used: 100, limit: 40000 });
  assert.deepEqual(snap.searches, { used: 5, limit: 5000 });
  assert.deepEqual(snap.onDemand, { used: 2, limit: 200 });
});
