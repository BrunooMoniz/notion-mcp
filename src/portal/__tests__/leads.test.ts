// src/portal/__tests__/leads.test.ts — invite-request leads (create/list/markInvited).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInviteRequest, listInviteRequests, markRequestInvited } from "../leads.js";
import { __setPoolForTest } from "../../rag/storage.js";

interface Row { email: string; name: string | null; note: string | null; status: string; invited_at: Date | null; }
let store: Map<string, Row>;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO invite_requests .* DO UPDATE\s+SET status/is.test(sql)) {
        // markRequestInvited
        const e = params[0];
        const r = store.get(e) ?? { email: e, name: null, note: null, status: "pending", invited_at: null };
        r.status = "invited";
        r.invited_at = new Date();
        store.set(e, r);
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO invite_requests/i.test(sql)) {
        // createInviteRequest
        const [email, name, note] = params;
        const r = store.get(email) ?? { email, name: null, note: null, status: "pending", invited_at: null };
        if (name) r.name = name;
        if (note) r.note = note;
        store.set(email, r);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT .* FROM invite_requests/is.test(sql)) {
        const rows = [...store.values()].map((r, i) => ({ id: i + 1, ...r, requested_at: new Date() }));
        return { rows };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  store = new Map();
  __setPoolForTest(memPool() as never);
});
afterEach(() => __setPoolForTest(null));

test("createInviteRequest normalizes the email", async () => {
  await createInviteRequest("  Friend@Example.COM ", "Friend");
  const rows = await listInviteRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "friend@example.com");
  assert.equal(rows[0].name, "Friend");
  assert.equal(rows[0].status, "pending");
});

test("markRequestInvited flips status to invited (creating the row if needed)", async () => {
  await markRequestInvited("new@x.com", "deadbeefhash");
  const rows = await listInviteRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "invited");
  assert.ok(rows[0].invited_at);
});
