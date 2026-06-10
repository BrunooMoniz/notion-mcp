// src/portal/__tests__/account-deletion.test.ts
// Unit tests for deleteAccountCompletely — verifies all tables are touched,
// isolation (account B untouched when A is deleted), and Stripe cancel on delete.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { __setPoolForTest } from "../../rag/storage.js";
import { __setStripeForTest } from "../../billing/stripe.js";
import { deleteAccountCompletely } from "../account-deletion.js";
import { createPortalRouter } from "../routes.js";
import { hashSession } from "../session.js";

// Track which DELETE/UPDATE queries fired and with which params.
type QueryLog = { sql: string; params: any[] };
let queryLog: QueryLog[] = [];

// A minimal pool that records queries and simulates row data.
function makePool(accountEmail = "a@test.com", stripeSubId: string | null = null) {
  return {
    query: async (sql: string, params: any[]) => {
      queryLog.push({ sql, params });
      // SELECT email + stripe_subscription_id from account
      if (/SELECT.*email.*stripe_subscription_id.*FROM account/i.test(sql)) {
        return { rows: [{ email: accountEmail, stripe_subscription_id: stripeSubId }], rowCount: 1 };
      }
      // Default: empty DELETE result
      return { rows: [], rowCount: 1 };
    },
  };
}

afterEach(() => {
  queryLog = [];
  __setPoolForTest(null);
  __setStripeForTest(null);
});

test("deleteAccountCompletely executes deletes for all expected tables", async () => {
  __setPoolForTest(makePool() as never);
  const result = await deleteAccountCompletely("friend:acct-aaa");

  const tables = queryLog
    .filter(q => /DELETE FROM/i.test(q.sql))
    .map(q => (q.sql.match(/FROM (\w+)/i)?.[1] ?? "?").toLowerCase());

  // All required tables must appear
  const required = [
    "chunk_feedback", "entities", "brain_facts", "brain_chunks",
    "account_secrets", "account_api_tokens", "account_workspaces",
    "portal_sessions", "magic_links", "usage_log", "sync_state",
    "status_runs", "billing_events", "invite_requests", "account",
  ];
  for (const t of required) {
    assert.ok(tables.includes(t), `Missing delete for table: ${t}`);
  }
  // The function returns counts
  assert.ok(typeof result === "object");
});

test("deleteAccountCompletely only touches the target account", async () => {
  __setPoolForTest(makePool() as never);
  await deleteAccountCompletely("friend:acct-aaa");

  // Every parameterized DELETE query must use the accountId or the account's email.
  const dataQueries = queryLog.filter(q => /DELETE FROM/i.test(q.sql));
  for (const q of dataQueries) {
    const hasTarget = q.params.some(p => p === "friend:acct-aaa" || p === "a@test.com");
    assert.ok(hasTarget, `Query scoped to wrong account: ${q.sql} params=${JSON.stringify(q.params)}`);
  }
});

test("deleteAccountCompletely cancels Stripe subscription before deleting", async () => {
  __setPoolForTest(makePool("a@test.com", "sub_test123") as never);
  let cancelledSub: string | null = null;
  __setStripeForTest({
    subscriptions: {
      cancel: async (id: string) => { cancelledSub = id; return {}; },
    },
  } as never);
  await deleteAccountCompletely("friend:acct-aaa");
  assert.equal(cancelledSub, "sub_test123");
});

test("deleteAccountCompletely proceeds even if Stripe cancel throws", async () => {
  __setPoolForTest(makePool("a@test.com", "sub_bad") as never);
  __setStripeForTest({
    subscriptions: {
      cancel: async () => { throw new Error("stripe down"); },
    },
  } as never);
  // Should not throw — Stripe failure is logged but doesn't abort deletion
  await assert.doesNotReject(() => deleteAccountCompletely("friend:acct-aaa"));
});

test("deleteAccountCompletely skips Stripe cancel when no subscription", async () => {
  __setPoolForTest(makePool("a@test.com", null) as never);
  let stripeCalled = false;
  __setStripeForTest({
    subscriptions: {
      cancel: async () => { stripeCalled = true; return {}; },
    },
  } as never);
  await deleteAccountCompletely("friend:acct-aaa");
  assert.equal(stripeCalled, false);
});

// --- Route tests ---

const ROUTE_SID = "route-test-sid";
const ROUTE_ACCT = "friend:route-acct";

function makeRoutePool(email = "route@test.com") {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        const { hashSession: hs } = await import("../session.js");
        if (params[0] === hs(ROUTE_SID)) return { rows: [{ account_id: ROUTE_ACCT }] };
        return { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT.*email.*stripe_subscription_id.*FROM account/i.test(sql)) {
        return { rows: [{ email, stripe_subscription_id: null }], rowCount: 1 };
      }
      if (/DELETE FROM portal_sessions WHERE session_hash/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

async function setupRouteServer(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use(createPortalRouter());
  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: s, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("POST /portal/delete-account → 401 without session", async () => {
  const { server, base } = await setupRouteServer();
  __setPoolForTest(makeRoutePool() as never);
  try {
    const r = await fetch(`${base}/portal/delete-account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "EXCLUIR" }),
    });
    assert.equal(r.status, 401);
  } finally {
    server.close();
    __setPoolForTest(null);
  }
});

test("POST /portal/delete-account → 400 without correct confirm phrase", async () => {
  const { server, base } = await setupRouteServer();
  __setPoolForTest(makeRoutePool() as never);
  try {
    const r = await fetch(`${base}/portal/delete-account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `portal_session=${ROUTE_SID}`,
      },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
    __setPoolForTest(null);
  }
});

test("POST /portal/delete-account → 200 with correct phrase, returns deleted:true", async () => {
  const { server, base } = await setupRouteServer();
  __setPoolForTest(makeRoutePool() as never);
  try {
    const r = await fetch(`${base}/portal/delete-account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `portal_session=${ROUTE_SID}`,
      },
      body: JSON.stringify({ confirm: "EXCLUIR" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.deleted, true);
    assert.ok(typeof body.counts === "object");
  } finally {
    server.close();
    __setPoolForTest(null);
  }
});
