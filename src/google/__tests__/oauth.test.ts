// src/google/__tests__/oauth.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { authUrl, SCOPES, exchangeCodeRaw, refreshAccessToken } from "../oauth.js";

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("SCOPES inclui readonly e events; authUrl carrega ambos", () => {
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.readonly"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.events"));
  const scope = new URL(authUrl("st8")).searchParams.get("scope") ?? "";
  assert.ok(scope.includes("calendar.readonly"));
  assert.ok(scope.includes("calendar.events"));
});

test("exchangeCodeRaw troca o code e retorna creds (sem salvar em disco)", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("oauth2.googleapis.com/token")) {
      assert.match(String(init.body), /grant_type=authorization_code/);
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt" }), { status: 200 });
    }
    if (u.includes("userinfo")) {
      return new Response(JSON.stringify({ email: "bruno@gmail.com" }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  }) as typeof fetch;

  const creds = await exchangeCodeRaw("the-code");
  assert.equal(creds.refresh_token, "rt");
  assert.equal(creds.granted_email, "bruno@gmail.com");
  assert.ok(calls.some((c) => c.includes("token")));
});

test("refreshAccessToken posta grant_type=refresh_token e retorna o token", async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.match(String(init.body), /grant_type=refresh_token/);
    assert.match(String(init.body), /rt-123/);
    return new Response(JSON.stringify({ access_token: "new-at", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;

  const r = await refreshAccessToken("rt-123");
  assert.equal(r.access_token, "new-at");
  assert.equal(r.expires_in, 3600);
});
