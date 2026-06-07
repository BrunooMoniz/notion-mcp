// src/billing/__tests__/ondemand-enforce.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string, used: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/sum\(qty\)/i.test(sql)) return { rows: [{ total: String(used) }] };
      return { rows: [] };
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("free plan -> on-demand always blocked", async () => {
  __setPoolForTest(memPool("free", 0) as never);
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 1), QuotaExceededError);
});

test("pro plan within daily cap -> allowed; over -> blocked", async () => {
  __setPoolForTest(memPool("pro", 190) as never);
  await assertOnDemandWithinLimit("friend:1", 10); // 200 ok
  __setPoolForTest(memPool("pro", 195) as never);
  __clearPlanCache();
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 10), QuotaExceededError);
});
