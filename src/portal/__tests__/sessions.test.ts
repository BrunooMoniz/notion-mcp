// src/portal/__tests__/sessions.test.ts
// GET /portal/sessions + POST /portal/sessions/revoke core. Sessions are listed
// per account with the `current` flag; revoke is gated on the SESSION account
// (another account's hash → false → 404). createSession persists a truncated
// user_agent (002-app-v2).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __setPoolForTest } from "../../rag/storage.js";
import { createSession, hashSession } from "../session.js";
import { listSessions, revokeSession } from "../sessions.js";

interface SessionRow {
  session_hash: string;
  account_id: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  user_agent: string | null;
}

let rows: SessionRow[];

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO portal_sessions/i.test(sql)) {
        rows.push({
          session_hash: params[0],
          account_id: params[1],
          expires_at: params[2],
          last_seen_at: params[3],
          created_at: params[3],
          user_agent: params[4] ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT session_hash, created_at, last_seen_at, user_agent/i.test(sql)) {
        const accountId = params[0];
        const now: Date = params[1];
        const found = rows
          .filter((r) => r.account_id === accountId && r.expires_at > now)
          .sort(
            (a, b) =>
              (b.last_seen_at?.getTime() ?? 0) - (a.last_seen_at?.getTime() ?? 0) ||
              b.created_at.getTime() - a.created_at.getTime(),
          )
          .map((r) => ({
            session_hash: r.session_hash,
            created_at: r.created_at,
            last_seen_at: r.last_seen_at,
            user_agent: r.user_agent,
          }));
        return { rows: found };
      }
      if (/DELETE FROM portal_sessions WHERE account_id=\$1 AND session_hash=\$2/i.test(sql)) {
        const before = rows.length;
        rows = rows.filter(
          (r) => !(r.account_id === params[0] && r.session_hash === params[1]),
        );
        return { rows: [], rowCount: before - rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

beforeEach(() => {
  rows = [];
  __setPoolForTest(memPool() as never);
});
afterEach(() => __setPoolForTest(null));

// --- createSession user_agent ---

test("createSession stores the user agent truncated to 200 chars", async () => {
  await createSession("acct-a", new Date(), 60_000, "Mozilla/5.0 ".padEnd(500, "x"));
  assert.equal(rows[0].user_agent?.length, 200);
  assert.ok(rows[0].user_agent!.startsWith("Mozilla/5.0"));
});

test("createSession stores user_agent null when absent", async () => {
  await createSession("acct-a");
  assert.equal(rows[0].user_agent, null);
});

// --- listSessions ---

test("listSessions returns only the account's sessions and flags the current one", async () => {
  const mine = await createSession("acct-a", new Date(), 60_000, "Safari");
  await createSession("acct-a", new Date(), 60_000, "Chrome");
  await createSession("acct-b", new Date(), 60_000, "Firefox");

  const list = await listSessions("acct-a", hashSession(mine));
  assert.equal(list.length, 2);
  assert.ok(!list.some((s) => s.user_agent === "Firefox")); // acct-b's session hidden
  const current = list.find((s) => s.current);
  assert.equal(current?.id, hashSession(mine));
  assert.equal(list.filter((s) => s.current).length, 1);
});

test("listSessions excludes expired sessions", async () => {
  const past = new Date(Date.now() - 60_000);
  await createSession("acct-a", past, 1, "Velho"); // expired long ago
  const live = await createSession("acct-a", new Date(), 60_000, "Novo");

  const list = await listSessions("acct-a", hashSession(live));
  assert.equal(list.length, 1);
  assert.equal(list[0].user_agent, "Novo");
});

// --- revokeSession ---

test("revokeSession deletes the account's session and returns true", async () => {
  const sid = await createSession("acct-a", new Date(), 60_000, "Safari");
  const ok = await revokeSession("acct-a", hashSession(sid));
  assert.equal(ok, true);
  assert.equal(rows.length, 0);
});

test("isolation: revoking another account's session hash returns false and leaves it intact", async () => {
  const victim = await createSession("acct-victim", new Date(), 60_000, "Safari");
  const ok = await revokeSession("acct-attacker", hashSession(victim));
  assert.equal(ok, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_id, "acct-victim");
});

test("revokeSession returns false for an unknown hash", async () => {
  const ok = await revokeSession("acct-a", "deadbeef");
  assert.equal(ok, false);
});
