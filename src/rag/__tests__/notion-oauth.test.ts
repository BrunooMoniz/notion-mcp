// src/rag/__tests__/notion-oauth.test.ts
// F3.2 — Notion onboarding OAuth. Pure URL building + injectable-fetch token
// exchange + DB onboarding via the __setPoolForTest stub. No network, no DB.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  accountIdForWorkspace,
  exchangeCodeForToken,
  onboardAccount,
  type NotionTokenResponse,
} from "../../notion-oauth.js";
import { __setPoolForTest } from "../storage.js";

const HEXKEY = "ab".repeat(32);
afterEach(() => __setPoolForTest(null));

test("accountIdForWorkspace prefixes so it never collides with 'bruno'", () => {
  assert.equal(accountIdForWorkspace("ws-123"), "notion:ws-123");
});

test("buildAuthorizeUrl sets the required Notion params", () => {
  const url = buildAuthorizeUrl({
    clientId: "cid",
    redirectUri: "https://x.test/notion/callback",
    state: "st8",
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://api.notion.com/v1/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("owner"), "user");
  assert.equal(u.searchParams.get("redirect_uri"), "https://x.test/notion/callback");
  assert.equal(u.searchParams.get("state"), "st8");
});

test("exchangeCodeForToken POSTs with Basic auth + correct body, returns parsed tokens", async () => {
  let captured: { url: string; init: any } | null = null;
  const fetchImpl = (async (url: string, init: any) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "ntn_access",
          refresh_token: "ntn_refresh",
          workspace_id: "ws1",
          workspace_name: "My WS",
          bot_id: "bot1",
        }),
    };
  }) as unknown as typeof fetch;

  const tok = await exchangeCodeForToken("the-code", "https://x.test/notion/callback", {
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl,
  });
  assert.equal(tok.access_token, "ntn_access");
  assert.equal(tok.workspace_id, "ws1");
  assert.equal(captured!.url, "https://api.notion.com/v1/oauth/token");
  assert.equal(captured!.init.method, "POST");
  const auth = captured!.init.headers.Authorization as string;
  assert.match(auth, /^Basic /);
  assert.equal(Buffer.from(auth.slice(6), "base64").toString("utf8"), "cid:csecret");
  const body = JSON.parse(captured!.init.body);
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.code, "the-code");
  assert.equal(body.redirect_uri, "https://x.test/notion/callback");
});

test("exchangeCodeForToken throws on non-2xx", async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: "invalid_grant" }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => exchangeCodeForToken("c", "r", { clientId: "i", clientSecret: "s", fetchImpl }),
    /token exchange failed.*invalid_grant/,
  );
});

test("exchangeCodeForToken throws when access_token/workspace_id missing", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ bot_id: "b" }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => exchangeCodeForToken("c", "r", { clientId: "i", clientSecret: "s", fetchImpl }),
    /missing access_token\/workspace_id/,
  );
});

test("onboardAccount creates account + workspace and stores ENCRYPTED tokens", async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as never);
  const prev = process.env.SECRETS_KEY;
  process.env.SECRETS_KEY = HEXKEY;
  let out;
  try {
    const tok: NotionTokenResponse = {
      access_token: "ntn_access_live",
      refresh_token: "ntn_refresh_live",
      workspace_id: "ws-xyz",
      workspace_name: "Acme",
    };
    out = await onboardAccount(tok);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = prev;
  }
  assert.deepEqual(out, { accountId: "notion:ws-xyz", workspace: "ws-xyz" });

  const sqls = queries.map((q) => q.sql).join("\n");
  assert.match(sqls, /INSERT INTO account /i);
  assert.match(sqls, /INSERT INTO account_workspaces/i);
  const secretInserts = queries.filter((q) => /INSERT INTO account_secrets/i.test(q.sql));
  assert.equal(secretInserts.length, 2, "access + refresh secrets stored");
  for (const s of secretInserts) {
    assert.equal(s.params[0], "notion:ws-xyz");
    assert.match(String(s.params[2]), /^v1:/); // encrypted envelope
    assert.doesNotMatch(String(s.params[2]), /ntn_(access|refresh)_live/); // never plaintext
  }
});

test("onboardAccount stores only the access token when no refresh token", async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as never);
  const prev = process.env.SECRETS_KEY;
  process.env.SECRETS_KEY = HEXKEY;
  try {
    await onboardAccount({ access_token: "a", workspace_id: "w2" });
  } finally {
    if (prev === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = prev;
  }
  const secretInserts = queries.filter((q) => /INSERT INTO account_secrets/i.test(q.sql));
  assert.equal(secretInserts.length, 1);
  assert.match(String(secretInserts[0].params[1]), /^notion_access:/);
});
