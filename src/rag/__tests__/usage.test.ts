// src/rag/__tests__/usage.test.ts
// F3.0 — passive metering. recordUsage appends to usage_log, best-effort, and
// no-ops cleanly when there's no DB/injected pool. Stub pool via __setPoolForTest.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import { recordUsage } from "../usage.js";

afterEach(() => __setPoolForTest(null));

test("recordUsage emits a parameterized INSERT into usage_log", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [], rowCount: 1 };
    },
  } as never);
  await recordUsage("bruno", "search", 1);
  assert.match(sql, /INSERT INTO usage_log \(account_id, metric, qty\)/i);
  assert.deepEqual(params, ["bruno", "search", 1]);
});

test("recordUsage floors qty and skips non-positive / non-finite", async () => {
  const calls: unknown[][] = [];
  __setPoolForTest({
    query: async (_q: string, p: unknown[]) => {
      calls.push(p);
      return { rows: [], rowCount: 1 };
    },
  } as never);
  await recordUsage("bruno", "embed_tokens", 12.9);
  await recordUsage("bruno", "search", 0); // skipped
  await recordUsage("bruno", "search", -5); // skipped
  await recordUsage("bruno", "search", NaN); // skipped
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["bruno", "embed_tokens", 12]);
});

test("recordUsage is a no-op when METERING_ENABLED=false", async () => {
  let called = false;
  __setPoolForTest({
    query: async () => {
      called = true;
      return { rows: [], rowCount: 1 };
    },
  } as never);
  const prev = process.env.METERING_ENABLED;
  process.env.METERING_ENABLED = "false";
  try {
    await recordUsage("bruno", "search", 1);
  } finally {
    if (prev === undefined) delete process.env.METERING_ENABLED;
    else process.env.METERING_ENABLED = prev;
  }
  assert.equal(called, false);
});

test("recordUsage swallows DB errors (best-effort, never throws)", async () => {
  __setPoolForTest({
    query: async () => {
      throw new Error("boom");
    },
  } as never);
  await recordUsage("bruno", "search", 1); // must not throw
});
