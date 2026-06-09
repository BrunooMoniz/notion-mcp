import { test } from "node:test";
import assert from "node:assert";
import { SCOPES, authUrl } from "../oauth.js";

test("SCOPES incluem identidade (openid + email) além de calendário", () => {
  assert.ok(SCOPES.includes("openid"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/userinfo.email"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.readonly"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.events"));
});

test("authUrl carrega o scope de email (URL-encoded)", () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.BASE_URL = "https://example.com";
  const url = authUrl("state123");
  assert.match(url, /scope=[^&]*userinfo\.email/);
  assert.match(url, /scope=openid[+%]/);
});
