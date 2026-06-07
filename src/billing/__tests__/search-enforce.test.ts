// src/billing/__tests__/search-enforce.test.ts
// brainSearch must throw QuotaExceededError for a friend over the monthly cap,
// and must NOT touch billing at all for the owner/default account.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../../context.js";
import { brainSearch } from "../../rag/search.js";
import { QuotaExceededError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string, searchSum: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/sum\(qty\)/i.test(sql)) return { rows: [{ total: String(searchSum) }] };
      // any other query (semantic/keyword) returns no rows
      return { rows: [] };
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("friend over the cap -> brainSearch throws QuotaExceededError before querying", async () => {
  __setPoolForTest(memPool("free", 100) as never);
  await requestContext.run(
    { authType: "bearer", scopes: "all", accountId: "friend:1" } as never,
    async () => {
      await assert.rejects(() => brainSearch("oi", { mode: "keyword", rerank: false }), QuotaExceededError);
    },
  );
});

test("owner/default account -> no billing query, search proceeds", async () => {
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) throw new Error("must not check plan for owner");
      return { rows: [] };
    },
  } as never);
  // No accountId in context -> getAccountId() === DEFAULT_ACCOUNT_ID ('bruno')
  const hits = await brainSearch("oi", { mode: "keyword", rerank: false });
  assert.ok(Array.isArray(hits));
});
