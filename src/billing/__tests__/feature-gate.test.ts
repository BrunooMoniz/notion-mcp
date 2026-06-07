// src/billing/__tests__/feature-gate.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { accountHasFeature } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string) {
  return { query: async (sql: string) => (/SELECT plan FROM account/i.test(sql) ? { rows: [{ plan }] } : { rows: [] }) };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("free has no granolaCalendar; essencial does", async () => {
  __setPoolForTest(memPool("free") as never);
  assert.equal(await accountHasFeature("friend:1", "granolaCalendar"), false);
  __setPoolForTest(memPool("essencial") as never); __clearPlanCache();
  assert.equal(await accountHasFeature("friend:1", "granolaCalendar"), true);
});

test("classifierRevisitar/briefing only pro+", async () => {
  __setPoolForTest(memPool("essencial") as never);
  assert.equal(await accountHasFeature("friend:1", "classifierRevisitar"), false);
  __setPoolForTest(memPool("pro") as never); __clearPlanCache();
  assert.equal(await accountHasFeature("friend:1", "briefing"), true);
});

test("owner default account has everything", async () => {
  __setPoolForTest({ query: async () => { throw new Error("no check"); } } as never);
  assert.equal(await accountHasFeature("bruno", "granolaCalendar"), true);
});
