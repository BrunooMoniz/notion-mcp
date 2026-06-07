// src/admin/__tests__/block.test.ts
// Objective #6 — operator block/unblock. blockAccount() must flip status to
// 'suspended' AND revoke the account's MCP bearers; unblockAccount() flips back to
// 'active' and does NOT revoke. Both bust the status cache so the /mcp guard sees
// the change immediately. Exercised with the __setPoolForTest stub + the existing
// account-bearer revoke seam (no live DB). auditWrite is fire-and-forget and never
// throws, so it needs no stubbing here.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { blockAccount, unblockAccount } from "../block.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { __clearBearerCache } from "../../account-bearer.js";
import {
  getAccountStatus,
  __clearStatusCache,
  ACTIVE_STATUS,
  SUSPENDED_STATUS,
} from "../../account-status.js";

afterEach(() => {
  __setPoolForTest(null);
  __clearStatusCache();
  __clearBearerCache();
});

/** Records every (sql, params) the code under test runs, with canned rowCounts. */
function recordingPool(rowCount: number) {
  const calls: { sql: string; params: unknown[] }[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount };
    },
  } as never);
  return calls;
}

test("blockAccount sets status='suspended' and revokes the account's bearers", async () => {
  const calls = recordingPool(1); // 1 row updated, 1 row deleted
  const res = await blockAccount("friend:1");

  const update = calls.find((c) => /UPDATE account SET status/i.test(c.sql));
  assert.ok(update, "ran an UPDATE account SET status");
  assert.deepEqual(update!.params, ["friend:1", SUSPENDED_STATUS]);

  const revoke = calls.find((c) => /DELETE FROM account_api_tokens/i.test(c.sql));
  assert.ok(revoke, "revoked the account's MCP bearers");
  assert.deepEqual(revoke!.params, ["friend:1"]);

  assert.equal(res.found, true);
  assert.equal(res.revoked, 1);
});

test("blockAccount on an unknown account: found=false, does NOT revoke", async () => {
  const calls = recordingPool(0); // 0 rows updated
  const res = await blockAccount("ghost:1");
  assert.equal(res.found, false);
  assert.equal(res.revoked, 0);
  assert.equal(calls.some((c) => /DELETE FROM account_api_tokens/i.test(c.sql)), false);
});

test("unblockAccount sets status='active' and does NOT revoke bearers", async () => {
  const calls = recordingPool(1);
  const res = await unblockAccount("friend:1");

  const update = calls.find((c) => /UPDATE account SET status/i.test(c.sql));
  assert.ok(update);
  assert.deepEqual(update!.params, ["friend:1", ACTIVE_STATUS]);
  assert.equal(calls.some((c) => /DELETE FROM account_api_tokens/i.test(c.sql)), false);
  assert.equal(res.found, true);
});

test("block then unblock busts the status cache (guard sees each change at once)", async () => {
  // The status the SELECT returns tracks what block/unblock just wrote.
  let stored = ACTIVE_STATUS;
  __setPoolForTest({
    query: async (sql: string) => {
      if (/UPDATE account SET status='?suspended/i.test(sql) || /SET status=\$2/i.test(sql)) {
        // status writes: infer the new value from the 2nd param via a closure below
      }
      if (/SELECT status FROM account/i.test(sql)) return { rows: [{ status: stored }] };
      return { rows: [], rowCount: 1 };
    },
  } as never);

  // Warm the cache as active.
  assert.equal(await getAccountStatus("friend:1"), ACTIVE_STATUS);

  // Block -> should bust cache; next read must reflect 'suspended'.
  stored = SUSPENDED_STATUS;
  await blockAccount("friend:1");
  assert.equal(await getAccountStatus("friend:1"), SUSPENDED_STATUS);

  // Unblock -> busts again; next read reflects 'active'.
  stored = ACTIVE_STATUS;
  await unblockAccount("friend:1");
  assert.equal(await getAccountStatus("friend:1"), ACTIVE_STATUS);
});
