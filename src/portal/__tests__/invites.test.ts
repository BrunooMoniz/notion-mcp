// src/portal/__tests__/invites.test.ts
// Invite codes: hash at rest, single atomic redemption, reuse refused.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateInviteCode,
  hashInvite,
  issueInvite,
  isInviteValid,
  redeemInvite,
} from "../invites.js";
import { __setPoolForTest } from "../../rag/storage.js";

afterEach(() => __setPoolForTest(null));

function memPool() {
  const rows = new Map<string, { redeemed_at: Date | null; acct: string | null }>();
  return {
    rows,
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO invite_codes/i.test(sql)) {
        if (!rows.has(params[0])) rows.set(params[0], { redeemed_at: null, acct: null });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT 1 FROM invite_codes/i.test(sql)) {
        const r = rows.get(params[0]);
        return { rows: r && r.redeemed_at === null ? [{ "?column?": 1 }] : [] };
      }
      if (/UPDATE invite_codes/i.test(sql)) {
        const r = rows.get(params[0]);
        if (r && r.redeemed_at === null) {
          r.redeemed_at = params[1];
          r.acct = params[2];
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
  };
}

test("generateInviteCode/hashInvite: random code, deterministic sha256 hex", () => {
  const a = generateInviteCode();
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, generateInviteCode());
  assert.equal(hashInvite("ABC"), hashInvite(" ABC ")); // trims
  assert.match(hashInvite("ABC"), /^[0-9a-f]{64}$/);
});

test("issued code is valid; storage holds the HASH not the code", async () => {
  const pool = memPool();
  __setPoolForTest(pool as never);
  const code = generateInviteCode();
  await issueInvite(code, "for Alice");
  assert.ok(pool.rows.has(hashInvite(code)));
  assert.ok(!pool.rows.has(code));
  assert.equal(await isInviteValid(code), true);
});

test("redeemInvite consumes exactly once; reuse is refused", async () => {
  __setPoolForTest(memPool() as never);
  const code = generateInviteCode();
  await issueInvite(code);
  assert.equal(await redeemInvite(code, "friend:1"), true);
  assert.equal(await redeemInvite(code, "friend:2"), false); // already used
  assert.equal(await isInviteValid(code), false);
});

test("unknown or empty codes are invalid and cannot be redeemed", async () => {
  __setPoolForTest(memPool() as never);
  assert.equal(await isInviteValid(""), false);
  assert.equal(await isInviteValid("nope"), false);
  assert.equal(await redeemInvite("", "friend:1"), false);
  assert.equal(await redeemInvite("nope", "friend:1"), false);
});
