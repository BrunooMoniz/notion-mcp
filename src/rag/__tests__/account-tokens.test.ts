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
  ensureAccountToken,
  invalidateAccountTokens,
  onAccountTokensInvalidated,
  isMissingTokenError,
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

// ─── Bug #96 (2a): fallback ao vault em cache-miss ───────────────────────────

test("ensureAccountToken busca o secret no vault em cache-miss e popula o cache", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool([], { "notion_access:ws-9": "tok9" });
  // cache frio: getAccountToken não acha nada
  assert.equal(getAccountToken("notion:acc", "ws-9", "pat"), undefined);
  const t = await ensureAccountToken("notion:acc", "ws-9", "pat");
  assert.equal(t, "tok9");
  // cache populado para os dois kinds (o mesmo token serve pat + search)
  assert.equal(getAccountToken("notion:acc", "ws-9", "pat"), "tok9");
  assert.equal(getAccountToken("notion:acc", "ws-9", "search"), "tok9");
});

test("ensureAccountToken cai para notion_pat quando não há notion_access", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool([], { "notion_pat:ws-p": "ntn_pat9" });
  assert.equal(await ensureAccountToken("notion-pat:acc", "ws-p", "pat"), "ntn_pat9");
});

test("ensureAccountToken devolve undefined quando o vault não tem secret (lança como hoje no caller)", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool([], {});
  assert.equal(await ensureAccountToken("notion:acc", "ws-x", "pat"), undefined);
  assert.equal(getAccountToken("notion:acc", "ws-x", "pat"), undefined);
});

test("ensureAccountToken devolve o token do cache sem ir ao vault quando já warmed", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool(["ws-1"], { "notion_access:ws-1": "tok1" });
  await warmAccount("notion:ws-1");
  // pool agora explode se consultado — o cache deve responder sozinho
  __setPoolForTest({
    query: async () => {
      throw new Error("não deveria consultar o vault em cache-hit");
    },
  } as never);
  assert.equal(await ensureAccountToken("notion:ws-1", "ws-1", "pat"), "tok1");
});

test("ensureAccountToken nunca consulta o vault para a conta default", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  __setPoolForTest({
    query: async () => {
      throw new Error("não deveria consultar o vault para a conta default");
    },
  } as never);
  assert.equal(await ensureAccountToken("bruno", "personal", "pat"), undefined);
});

// ─── Bug #96 (2b): invalidação do cache em connect/disconnect ────────────────

test("invalidateAccountTokens derruba o cache da conta e notifica hooks", async () => {
  process.env.SECRETS_KEY = HEXKEY;
  stubPool(["ws-1"], { "notion_access:ws-1": "tok1" });
  await warmAccount("notion:ws-1");
  assert.equal(isWarmed("notion:ws-1"), true);

  const seen: string[] = [];
  onAccountTokensInvalidated((accountId) => seen.push(accountId));
  invalidateAccountTokens("notion:ws-1");

  assert.equal(isWarmed("notion:ws-1"), false);
  assert.equal(getAccountToken("notion:ws-1", "ws-1", "pat"), undefined);
  assert.deepEqual(seen, ["notion:ws-1"]);
});

// ─── Bug #96 (2c): detector do erro de token ausente (agregação de skips) ───

test("isMissingTokenError reconhece o erro de cache-miss e ignora os demais", () => {
  assert.equal(
    isMissingTokenError(new Error('no pat token for account "friend:x" workspace "ws" (warmAccount first)')),
    true,
  );
  assert.equal(
    isMissingTokenError(new Error('no search token for account "friend:x" workspace "ws" (warmAccount first)')),
    true,
  );
  assert.equal(isMissingTokenError(new Error("API rate limited")), false);
  assert.equal(isMissingTokenError(null), false);
});
