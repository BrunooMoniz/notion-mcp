// src/portal/__tests__/mcp-token-label.test.ts
// POST /portal/mcp-token — optional body {label} becomes the bearer's label
// (shown as the client in "O que sua IA buscou"): trimmed, capped at 40 chars,
// fallback "portal" when absent/empty. The route still revokes prior tokens and
// returns the plaintext token + mcp_url.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createPortalRouter } from "../routes.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { hashSession } from "../session.js";

const SID = "test-session-mcp-token";
const ACCOUNT = "acct_mcp_token_test";

let inserted: { params: any[] }[] = [];
let revoked = 0;

function fakePool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        return params[0] === hashSession(SID)
          ? { rows: [{ account_id: ACCOUNT }] }
          : { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM account_api_tokens/i.test(sql)) {
        revoked++;
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO account_api_tokens/i.test(sql)) {
        inserted.push({ params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

let server: Server;
let base = "";

before(async () => {
  __setPoolForTest(fakePool() as never);
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

beforeEach(() => {
  inserted = [];
  revoked = 0;
});

async function postToken(body?: unknown) {
  return fetch(`${base}/portal/mcp-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `portal_session=${SID}`,
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

test("POST /portal/mcp-token with {label} issues the bearer with that label (trimmed)", async () => {
  const res = await postToken({ label: "  Claude Code  " });
  assert.equal(res.status, 200);
  const out = (await res.json()) as { token: string; mcp_url: string };
  assert.match(out.token, /^acct_/);
  assert.ok(out.mcp_url.endsWith("/mcp"));

  assert.equal(revoked, 1); // old tokens revoked first (single active token)
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].params[1], ACCOUNT); // account from SESSION
  assert.equal(inserted[0].params[2], "Claude Code"); // trimmed label stored
});

test("POST /portal/mcp-token without label falls back to 'portal'", async () => {
  const res = await postToken();
  assert.equal(res.status, 200);
  assert.equal(inserted[0].params[2], "portal");
});

test("POST /portal/mcp-token with an empty/whitespace label falls back to 'portal'", async () => {
  const res = await postToken({ label: "   " });
  assert.equal(res.status, 200);
  assert.equal(inserted[0].params[2], "portal");
});

test("POST /portal/mcp-token caps the label at 40 chars", async () => {
  const res = await postToken({ label: "x".repeat(100) });
  assert.equal(res.status, 200);
  assert.equal(inserted[0].params[2], "x".repeat(40));
});
