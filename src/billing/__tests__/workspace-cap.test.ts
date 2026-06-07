// src/billing/__tests__/workspace-cap.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertCanAddWorkspace, WorkspaceLimitError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string, wsCount: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/count\(\*\)::text AS n FROM account_workspaces/i.test(sql)) return { rows: [{ n: String(wsCount) }] };
      return { rows: [] };
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("free (1 ws) -> second workspace blocked", async () => {
  __setPoolForTest(memPool("free", 1) as never);
  await assert.rejects(() => assertCanAddWorkspace("friend:1"), WorkspaceLimitError);
});

test("pro (3 ws) -> third allowed, fourth blocked", async () => {
  __setPoolForTest(memPool("pro", 2) as never);
  await assertCanAddWorkspace("friend:1"); // 3rd ok
  __setPoolForTest(memPool("pro", 3) as never); __clearPlanCache();
  await assert.rejects(() => assertCanAddWorkspace("friend:1"), WorkspaceLimitError);
});

test("owner/default exempt", async () => {
  __setPoolForTest({ query: async () => { throw new Error("no check"); } } as never);
  await assertCanAddWorkspace("bruno");
});
