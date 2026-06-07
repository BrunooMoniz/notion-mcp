// src/portal/__tests__/connect-window.test.ts
// POST /portal/connect-window opens a SHORT OAuth registration window, but ONLY
// for a signed-in (invite-verified) friend. No session → 401 and the window
// stays shut. The account scope comes from the resolved session, never input.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createPortalRouter } from "../routes.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { hashSession } from "../session.js";
import { isRegistrationOpen, closeRegistrationWindow } from "../../oauth-registration-window.js";

// Pool that recognizes exactly one session id → account (mirrors resolveSession).
const SID = "test-session-id";
function sessionPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        return params[0] === hashSession(SID)
          ? { rows: [{ account_id: "acct_test" }] }
          : { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}

let server: Server;
let base = "";

before(async () => {
  __setPoolForTest(sessionPool() as never);
  const app = express();
  app.use(express.json());
  app.use(createPortalRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  __setPoolForTest(null);
});

afterEach(() => closeRegistrationWindow());

test("no session → 401, window stays closed", async () => {
  closeRegistrationWindow();
  const res = await fetch(`${base}/portal/connect-window`, { method: "POST" });
  assert.equal(res.status, 401);
  assert.equal(isRegistrationOpen(), false);
});

test("signed-in friend → 200, opens the window, returns mcp_url + expiry", async () => {
  closeRegistrationWindow();
  assert.equal(isRegistrationOpen(), false);
  const res = await fetch(`${base}/portal/connect-window`, {
    method: "POST",
    headers: { cookie: `portal_session=${SID}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(isRegistrationOpen(), true);
  assert.ok(typeof body.mcp_url === "string" && body.mcp_url.endsWith("/mcp"));
  assert.ok(typeof body.open_until === "string");
  assert.ok(body.ttl_seconds > 0);
});
