// src/admin/__tests__/account-status.test.ts
// Objective #6 — the auth-path suspension guard. isAccountAllowed() is the PURE
// classifier the /mcp middleware uses to decide access; it must fail closed.
// getAccountStatus()/isAccountActive() add a short TTL cache over a single SELECT,
// tested via the __setPoolForTest stub (no live DB). These cover the exact decision
// the middleware makes: a suspended account is rejected, an active one passes, and
// a missing/unknown account row is denied (fail-closed).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isAccountAllowed,
  getAccountStatus,
  isAccountActive,
  bustAccountStatus,
  __clearStatusCache,
  ACTIVE_STATUS,
  SUSPENDED_STATUS,
} from "../../account-status.js";
import { __setPoolForTest } from "../../rag/storage.js";

afterEach(() => {
  __setPoolForTest(null);
  __clearStatusCache();
});

// --- Pure classifier (the actual guard the auth middleware applies) ---

test("isAccountAllowed: only 'active' passes", () => {
  assert.equal(isAccountAllowed(ACTIVE_STATUS), true);
});

test("isAccountAllowed: 'suspended' is rejected", () => {
  assert.equal(isAccountAllowed(SUSPENDED_STATUS), false);
});

test("isAccountAllowed: fail-closed on null/undefined/unknown", () => {
  assert.equal(isAccountAllowed(null), false);
  assert.equal(isAccountAllowed(undefined), false);
  assert.equal(isAccountAllowed(""), false);
  assert.equal(isAccountAllowed("paused"), false);
  assert.equal(isAccountAllowed("ACTIVE"), false); // case-sensitive on purpose
});

// --- Cached resolution + the active check the middleware calls ---

test("getAccountStatus reads status by id and caches it (one DB hit per TTL)", async () => {
  let hits = 0;
  __setPoolForTest({
    query: async (sql: string, p: unknown[]) => {
      hits++;
      assert.match(sql, /SELECT status FROM account WHERE id=\$1/i);
      assert.deepEqual(p, ["friend:1"]);
      return { rows: [{ status: SUSPENDED_STATUS }] };
    },
  } as never);
  assert.equal(await getAccountStatus("friend:1"), SUSPENDED_STATUS);
  assert.equal(await getAccountStatus("friend:1"), SUSPENDED_STATUS); // cached
  assert.equal(hits, 1);
});

test("isAccountActive: active account -> true, suspended -> false (the auth gate)", async () => {
  __setPoolForTest({
    query: async (_sql: string, p: unknown[]) =>
      p[0] === "active:1" ? { rows: [{ status: ACTIVE_STATUS }] } : { rows: [{ status: SUSPENDED_STATUS }] },
  } as never);
  assert.equal(await isAccountActive("active:1"), true);
  assert.equal(await isAccountActive("blocked:1"), false);
});

test("isAccountActive: missing account row -> false (fail-closed)", async () => {
  __setPoolForTest({ query: async () => ({ rows: [] }) } as never);
  assert.equal(await isAccountActive("ghost:1"), false);
});

test("bustAccountStatus forces a fresh read (block takes effect before TTL)", async () => {
  let status = ACTIVE_STATUS;
  let hits = 0;
  __setPoolForTest({
    query: async () => {
      hits++;
      return { rows: [{ status }] };
    },
  } as never);
  assert.equal(await isAccountActive("friend:1"), true);
  status = SUSPENDED_STATUS; // operator blocks
  bustAccountStatus("friend:1"); // route busts the cache
  assert.equal(await isAccountActive("friend:1"), false); // re-read sees the block
  assert.equal(hits, 2);
});

test("getAccountStatus: a DB error propagates (middleware denies on throw, never open)", async () => {
  __setPoolForTest({
    query: async () => {
      throw new Error("db down");
    },
  } as never);
  await assert.rejects(() => isAccountActive("friend:1"), /db down/);
});
