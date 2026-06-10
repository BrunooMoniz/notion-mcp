// src/portal/__tests__/workspace-name-resolver.test.ts
// 1.2: tests for resolveWorkspaceName — derives workspace name from Notion API
// given either a PAT (notion_pat:<ws>) or an OAuth access token (notion_access:<ws>).
// All HTTP deps are mocked; no live DB or network required.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWorkspaceName } from "../workspace-name-resolver.js";

function makeNotion200(body: object): typeof fetch {
  return async (_url: any, _init: any) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as any;
}

function makeNotion401(): typeof fetch {
  return async (_url: any, _init: any) =>
    new Response(JSON.stringify({ code: "unauthorized", message: "Token is not valid." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }) as any;
}

// PAT: /v1/users/me returns bot.workspace_name
test("resolveWorkspaceName for PAT extracts bot.workspace_name", async () => {
  const fetchImpl = makeNotion200({
    object: "user",
    type: "bot",
    bot: {
      workspace_name: "Cérebro do Bruno",
      owner: { type: "user", user: { id: "user-1" } },
    },
  });
  const name = await resolveWorkspaceName("ntn_pat_token", { fetchImpl });
  assert.equal(name, "Cérebro do Bruno");
});

// OAuth access token: /v1/users/me also returns bot.workspace_name
test("resolveWorkspaceName for OAuth access token extracts workspace_name", async () => {
  const fetchImpl = makeNotion200({
    object: "user",
    type: "bot",
    bot: {
      workspace_name: "Acme Inc",
      owner: { type: "workspace", workspace: true },
    },
  });
  const name = await resolveWorkspaceName("secret_oauth_token", { fetchImpl });
  assert.equal(name, "Acme Inc");
});

// Fallback: top-level name field
test("resolveWorkspaceName falls back to top-level name when no bot.workspace_name", async () => {
  const fetchImpl = makeNotion200({ object: "user", type: "person", name: "Fallback Name" });
  const name = await resolveWorkspaceName("token", { fetchImpl });
  assert.equal(name, "Fallback Name");
});

// Invalid token: returns null instead of throwing (backfill should skip, not crash)
test("resolveWorkspaceName returns null on 401 (invalid token)", async () => {
  const name = await resolveWorkspaceName("bad_token", { fetchImpl: makeNotion401() });
  assert.equal(name, null);
});

// Network error: returns null
test("resolveWorkspaceName returns null on network error", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const name = await resolveWorkspaceName("token", { fetchImpl: fetchImpl as any });
  assert.equal(name, null);
});
