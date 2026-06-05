// src/rag/__tests__/account-tokens.test.ts
// F3.2b — per-account token resolution. Stub the pool so warmAccount reads
// account_workspaces + (encrypted) account_secrets without a live DB.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  warmAccount,
  getAccountToken,
  getWarmedWorkspaces,
  isWarmed,
  __clearAccountTokenCache,
} from "../../account-tokens.js";
import { encryptSecret } from "../../secrets.js";
import { __setPoolForTest } from "../storage.js";

const HEXKEY = "ab".repeat(32);

afterEach(() => {
  __setPoolForTest(null);
  __clearAccountTokenCache();
});

/** Build a stub pool that answers the two queries warmAccount makes. */
function stubPool(workspaces: string[], secrets: Record<string, string>) {
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      if (/FROM account_workspaces/i.test(sql)) {
        return { rows: workspaces.map((w) => ({ workspace: w })) };
      }
      if (/FROM account_secrets/i.test(sql)) {
        const kind = params[1] as string; // (account_id, kind)
        const plain = secrets[kind];
        return { rows: plain ? [{ enc_value: encryptSecret(plain, Buffer.from(HEXKEY, "hex")) }] : [] };
      }
      return { rows: [] };
    },
  } as never);
}

test("warmAccount caches an OAuth account's token and lists its workspace", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool(["ws-1"], { "notion_access:ws-1": "oauth_tok_1" });
  const ws = await warmAccount("notion:ws-1");
  assert.deepEqual(ws, ["ws-1"]);
  assert.equal(isWarmed("notion:ws-1"), true);
  assert.equal(getAccountToken("notion:ws-1", "ws-1", "pat"), "oauth_tok_1");
  assert.equal(getAccountToken("notion:ws-1", "ws-1", "search"), "oauth_tok_1");
  assert.deepEqual(getWarmedWorkspaces("notion:ws-1"), ["ws-1"]);
});

test("warmAccount falls back to a PAT secret when no OAuth access token", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool(["wsp"], { "notion_pat:wsp": "ntn_pat_tok" });
  await warmAccount("notion-pat:wsp");
  assert.equal(getAccountToken("notion-pat:wsp", "wsp", "pat"), "ntn_pat_tok");
});

test("'bruno' is never cached here (resolves from .env in clients.ts)", async () => {
  const ws = await warmAccount("bruno");
  assert.deepEqual(ws, []);
  assert.equal(isWarmed("bruno"), false);
});

test("getAccountToken returns undefined when not warmed", () => {
  assert.equal(getAccountToken("notion:unknown", "ws", "pat"), undefined);
});

test("a workspace with no stored token is skipped (not listed)", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool(["ws-a", "ws-b"], { "notion_access:ws-a": "tokA" }); // ws-b has nothing
  const ws = await warmAccount("notion:multi");
  assert.deepEqual(ws, ["ws-a"]);
  assert.equal(getAccountToken("notion:multi", "ws-b", "pat"), undefined);
});
