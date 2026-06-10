// src/rag/__tests__/search-log.test.ts
// 002-app-v2 — ai_search_log writer/reader. recordSearchEvent is best-effort
// (truncates the query, swallows pool errors, no-ops without a pool) and
// brainSearch only appends it for in-request searches (RequestContext present).
// listSearchEvents is account-scoped: A never sees B's rows.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __setPoolForTest } from "../storage.js";
import { recordSearchEvent, listSearchEvents } from "../search-log.js";
import { brainSearch, __setSearchDepsForTest } from "../search.js";
import { requestContext, DEFAULT_ACCOUNT_ID } from "../../context.js";

interface LogRow {
  account_id: string;
  query: string;
  results: number;
  client: string | null;
  ts: Date;
}

let rows: LogRow[];

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO ai_search_log/i.test(sql)) {
        rows.push({
          account_id: params[0],
          query: params[1],
          results: params[2],
          client: params[3],
          ts: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT query, results, client, ts\s+FROM ai_search_log/i.test(sql)) {
        const accountId = params[0];
        const limit = params[2];
        const found = rows
          .filter((r) => r.account_id === accountId)
          .sort((a, b) => b.ts.getTime() - a.ts.getTime())
          .slice(0, limit);
        return { rows: found };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

beforeEach(() => {
  rows = [];
  __setPoolForTest(memPool() as never);
});
afterEach(() => {
  __setPoolForTest(null);
  __setSearchDepsForTest(null);
});

// --- recordSearchEvent ---

test("recordSearchEvent stores account, query, results and client", async () => {
  await recordSearchEvent("acct-a", "reunião com a Nora", 5, "Claude.ai");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_id, "acct-a");
  assert.equal(rows[0].query, "reunião com a Nora");
  assert.equal(rows[0].results, 5);
  assert.equal(rows[0].client, "Claude.ai");
});

test("recordSearchEvent truncates the query to 300 chars", async () => {
  await recordSearchEvent("acct-a", "x".repeat(500), 1, "Assistente");
  assert.equal(rows[0].query.length, 300);
});

test("recordSearchEvent stores client null when not provided", async () => {
  await recordSearchEvent("acct-a", "q", 0);
  assert.equal(rows[0].client, null);
});

test("recordSearchEvent swallows pool errors (never throws)", async () => {
  __setPoolForTest({
    query: async () => {
      throw new Error("db down");
    },
  } as never);
  await assert.doesNotReject(recordSearchEvent("acct-a", "q", 1, "c"));
});

test("recordSearchEvent no-ops without a pool (no POSTGRES_URL, none injected)", async () => {
  __setPoolForTest(null);
  const prev = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;
  try {
    await assert.doesNotReject(recordSearchEvent("acct-a", "q", 1));
  } finally {
    if (prev !== undefined) process.env.POSTGRES_URL = prev;
  }
});

// --- listSearchEvents (account scoping) ---

test("listSearchEvents returns only the given account's searches", async () => {
  await recordSearchEvent("acct-a", "minha busca", 3, "Consultar");
  await recordSearchEvent("acct-b", "busca alheia", 7, "Claude.ai");

  const list = await listSearchEvents("acct-a");
  assert.equal(list.length, 1);
  assert.equal(list[0].query, "minha busca");
  assert.equal(list[0].results, 3);
  assert.equal(list[0].client, "Consultar");
  assert.ok(!list.some((e) => e.query === "busca alheia"));
});

// --- brainSearch instrumentation ---

const fakeDeps = {
  searchSemantic: async () => [],
  searchKeyword: async () => [],
  embedQuery: async () => [0.1, 0.2],
  rerankDocuments: async () => [],
  getAllowedWorkspaces: () => null,
};

test("brainSearch logs the search (with the context tokenLabel) when in a request", async () => {
  __setSearchDepsForTest(fakeDeps as never);
  await requestContext.run(
    { authType: "bearer", scopes: "all", accountId: DEFAULT_ACCOUNT_ID, tokenLabel: "MeuBot" },
    () => brainSearch("o que decidimos ontem?"),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, "o que decidimos ontem?");
  assert.equal(rows[0].results, 0); // fake deps return no hits
  assert.equal(rows[0].client, "MeuBot");
});

test("brainSearch does NOT log outside a request context (cron/eval)", async () => {
  __setSearchDepsForTest(fakeDeps as never);
  await brainSearch("nightly eval query");
  assert.equal(rows.length, 0);
});

test("brainSearch with logEvent:false does NOT log even inside a request (internal searches)", async () => {
  __setSearchDepsForTest(fakeDeps as never);
  await requestContext.run(
    { authType: "bearer", scopes: "all", accountId: DEFAULT_ACCOUNT_ID, tokenLabel: "MeuBot" },
    () => brainSearch("contexto interno do briefing", { logEvent: false }),
  );
  assert.equal(rows.length, 0);
});
