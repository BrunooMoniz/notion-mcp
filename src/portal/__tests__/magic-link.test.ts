// src/portal/__tests__/magic-link.test.ts
// Magic links: hash at rest, single-use, expiry rejected, reissue supersedes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateMagicToken,
  hashMagic,
  issueMagicLink,
  consumeMagicLink,
  generateLoginCode,
  issueLoginCode,
  consumeLoginCode,
} from "../magic-link.js";
import { __setPoolForTest } from "../../rag/storage.js";

afterEach(() => __setPoolForTest(null));

interface Row {
  email: string;
  account_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

function memPool() {
  const rows = new Map<string, Row>();
  return {
    rows,
    query: async (sql: string, params: any[]) => {
      if (/DELETE FROM magic_links/i.test(sql)) {
        for (const [h, r] of rows) {
          if (r.email === params[0] && r.consumed_at === null) rows.delete(h);
        }
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO magic_links/i.test(sql)) {
        rows.set(params[0], {
          email: params[1],
          account_id: params[2],
          expires_at: params[3],
          consumed_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE magic_links/i.test(sql)) {
        const r = rows.get(params[0]);
        const now = new Date(params[1]);
        if (r && r.consumed_at === null && new Date(r.expires_at) > now) {
          r.consumed_at = now;
          return { rows: [{ email: r.email, account_id: r.account_id }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("generateMagicToken/hashMagic: opaque token, sha256 hex hash", () => {
  const t = generateMagicToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.match(hashMagic(t), /^[0-9a-f]{64}$/);
  assert.notEqual(hashMagic(t), t);
});

test("issued link stores the HASH and consumes exactly once", async () => {
  const pool = memPool();
  __setPoolForTest(pool as never);
  const token = await issueMagicLink("a@b.com", "friend:1");
  assert.ok(pool.rows.has(hashMagic(token)));
  assert.ok(!pool.rows.has(token));
  assert.deepEqual(await consumeMagicLink(token), { email: "a@b.com", accountId: "friend:1" });
  assert.equal(await consumeMagicLink(token), null); // single-use
});

test("expired link is rejected", async () => {
  __setPoolForTest(memPool() as never);
  const now = new Date("2026-01-01T00:00:00Z");
  const token = await issueMagicLink("a@b.com", null, now, 1000);
  const later = new Date(now.getTime() + 5000);
  assert.equal(await consumeMagicLink(token, later), null);
});

test("reissuing for an email invalidates the prior unconsumed link", async () => {
  __setPoolForTest(memPool() as never);
  const first = await issueMagicLink("a@b.com", "friend:1");
  const second = await issueMagicLink("a@b.com", "friend:1");
  assert.equal(await consumeMagicLink(first), null); // superseded
  assert.deepEqual(await consumeMagicLink(second), { email: "a@b.com", accountId: "friend:1" });
});

test("unknown/empty tokens return null", async () => {
  __setPoolForTest(memPool() as never);
  assert.equal(await consumeMagicLink(undefined), null);
  assert.equal(await consumeMagicLink("nope"), null);
});

test("generateLoginCode is 6 digits", () => {
  for (let i = 0; i < 50; i++) assert.match(generateLoginCode(), /^\d{6}$/);
});

test("login code: issue → consume once, scoped to its email, single-use", async () => {
  __setPoolForTest(memPool() as never);
  const code = await issueLoginCode("a@b.com", "friend:1");
  assert.match(code, /^\d{6}$/);
  // wrong email must not validate the code
  assert.equal(await consumeLoginCode("other@b.com", code), null);
  // correct email + code works once
  assert.deepEqual(await consumeLoginCode("a@b.com", code), { email: "a@b.com", accountId: "friend:1" });
  // and only once
  assert.equal(await consumeLoginCode("a@b.com", code), null);
});

test("login code: bad format rejected without a DB hit", async () => {
  __setPoolForTest(memPool() as never);
  assert.equal(await consumeLoginCode("a@b.com", "12345"), null); // 5 digits
  assert.equal(await consumeLoginCode("a@b.com", "abcdef"), null);
  assert.equal(await consumeLoginCode("", "123456"), null);
});
