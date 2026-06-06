// src/portal/__tests__/session.test.ts
// Portal sessions: hash at rest, create→resolve, expiry rejected, destroy revokes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  resolveSession,
  destroySession,
  hashSession,
  generateSessionId,
} from "../session.js";
import { __setPoolForTest } from "../../rag/storage.js";

afterEach(() => __setPoolForTest(null));

function memPool() {
  const rows = new Map<string, { account_id: string; expires_at: Date }>();
  return {
    rows,
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO portal_sessions/i.test(sql)) {
        rows.set(params[0], { account_id: params[1], expires_at: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        const r = rows.get(params[0]);
        if (r && new Date(r.expires_at) > new Date(params[1])) {
          return { rows: [{ account_id: r.account_id }] };
        }
        return { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) {
        const r = rows.get(params[0]);
        if (r) r.expires_at = params[2];
        return { rows: [], rowCount: r ? 1 : 0 };
      }
      if (/DELETE FROM portal_sessions/i.test(sql)) {
        return { rows: [], rowCount: rows.delete(params[0]) ? 1 : 0 };
      }
      return { rows: [] };
    },
  };
}

test("generateSessionId/hashSession: opaque id, sha256 hex hash", () => {
  const id = generateSessionId();
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.match(hashSession(id), /^[0-9a-f]{64}$/);
  assert.notEqual(hashSession(id), id); // cookie value never equals stored hash
});

test("createSession stores the HASH (not the id) and resolve returns the account", async () => {
  const pool = memPool();
  __setPoolForTest(pool as never);
  const id = await createSession("friend:abc");
  // stored key is the hash of the id, never the id itself
  assert.ok(pool.rows.has(hashSession(id)));
  assert.ok(!pool.rows.has(id));
  assert.equal(await resolveSession(id), "friend:abc");
});

test("resolveSession rejects an expired session", async () => {
  __setPoolForTest(memPool() as never);
  const now = new Date("2026-01-01T00:00:00Z");
  const id = await createSession("friend:abc", now, 1000); // 1s ttl
  const later = new Date(now.getTime() + 5000);
  assert.equal(await resolveSession(id, later), null);
});

test("resolveSession returns null for missing/unknown ids", async () => {
  __setPoolForTest(memPool() as never);
  assert.equal(await resolveSession(undefined), null);
  assert.equal(await resolveSession("deadbeef"), null);
});

test("destroySession revokes the session", async () => {
  __setPoolForTest(memPool() as never);
  const id = await createSession("friend:abc");
  await destroySession(id);
  assert.equal(await resolveSession(id), null);
});
