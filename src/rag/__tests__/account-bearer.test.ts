// src/rag/__tests__/account-bearer.test.ts
// F3.2c — per-account MCP bearer. Generation/hash are pure; issue/resolve use the
// __setPoolForTest stub (no live DB). Asserts only the HASH is stored (not the
// token) and resolve returns the account + its workspaces, fast-rejecting others.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateBearer,
  hashBearer,
  issueBearer,
  resolveBearer,
  __clearBearerCache,
} from "../../account-bearer.js";
import { __setPoolForTest } from "../storage.js";

afterEach(() => {
  __setPoolForTest(null);
  __clearBearerCache();
});

test("generateBearer is prefixed and unique", () => {
  const a = generateBearer();
  const b = generateBearer();
  assert.match(a, /^acct_[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("hashBearer is deterministic sha256 hex", () => {
  assert.equal(hashBearer("acct_x"), hashBearer("acct_x"));
  assert.match(hashBearer("acct_x"), /^[0-9a-f]{64}$/);
});

test("issueBearer stores the HASH (never the token) and returns the plaintext", async () => {
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (_q: string, p: unknown[]) => {
      params = p;
      return { rows: [], rowCount: 1 };
    },
  } as never);
  const token = await issueBearer("notion:ws-1", "claude");
  assert.match(token, /^acct_/);
  assert.equal(params[0], hashBearer(token)); // stored value is the hash
  assert.notEqual(params[0], token); // never the token itself
  assert.equal(params[1], "notion:ws-1");
});

test("resolveBearer maps a token to its account + workspaces + label", async () => {
  __setPoolForTest({
    query: async (sql: string) => {
      if (/FROM account_api_tokens/i.test(sql)) return { rows: [{ account_id: "notion:ws-1", label: "claude-code" }] };
      if (/FROM account_workspaces/i.test(sql)) return { rows: [{ workspace: "ws-1" }] };
      return { rows: [] };
    },
  } as never);
  const r = await resolveBearer("acct_deadbeef");
  assert.deepEqual(r, { accountId: "notion:ws-1", workspaces: ["ws-1"], label: "claude-code" });
});

test("resolveBearer fast-rejects non-account tokens without a DB hit", async () => {
  let hit = false;
  __setPoolForTest({
    query: async () => {
      hit = true;
      return { rows: [] };
    },
  } as never);
  assert.equal(await resolveBearer("some-static-bearer-token"), null);
  assert.equal(await resolveBearer(""), null);
  assert.equal(await resolveBearer(undefined), null);
  assert.equal(hit, false); // never queried the DB
});

test("resolveBearer returns null for an unknown account token", async () => {
  __setPoolForTest({ query: async () => ({ rows: [] }) } as never);
  assert.equal(await resolveBearer("acct_unknown"), null);
});

import { revokeBearersForAccount } from "../../account-bearer.js";

test("revokeBearersForAccount deletes the account's tokens and returns the count", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [], rowCount: 2 };
    },
  } as never);
  const n = await revokeBearersForAccount("notion:ws-1");
  assert.match(sql, /DELETE FROM account_api_tokens WHERE account_id=\$1/i);
  assert.deepEqual(params, ["notion:ws-1"]);
  assert.equal(n, 2);
});

import { accountWorkspaces } from "../../account-bearer.js";

test("accountWorkspaces orders by created_at ASC (deterministic ws[0] fallback)", async () => {
  let sql = "";
  __setPoolForTest({
    query: async (q: string) => {
      sql = q;
      return { rows: [{ workspace: "first-connected" }, { workspace: "later" }] };
    },
  } as never);
  const ws = await accountWorkspaces("notion:ws-1");
  assert.deepEqual(ws, ["first-connected", "later"]);
  // Multi-workspace accounts must get a stable order: first workspace connected
  // first (callers use ws[0] as the default workspace tag, e.g. index-web).
  assert.match(sql, /ORDER BY created_at ASC/i);
});

test("resolveBearer resolves workspaces with the same deterministic ordering", async () => {
  let wsSql = "";
  __setPoolForTest({
    query: async (q: string) => {
      if (/FROM account_api_tokens/i.test(q)) return { rows: [{ account_id: "notion:ws-1", label: null }] };
      if (/FROM account_workspaces/i.test(q)) {
        wsSql = q;
        return { rows: [{ workspace: "ws-1" }] };
      }
      return { rows: [] };
    },
  } as never);
  await resolveBearer("acct_orderedfetch");
  assert.match(wsSql, /ORDER BY created_at ASC/i);
});
