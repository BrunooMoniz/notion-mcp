// src/google/__tests__/google-token.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);
process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";

import { getGoogleAccessTokenFor, resolveCalendarRef, __clearGoogleTokenCache } from "../google-token.js";
import { addGoogleAccount } from "../google-accounts.js";
import { encodeCalendarRef } from "../calendar-ref.js";
import { __setPoolForTest } from "../../rag/storage.js";

let store: Map<string, string>;
function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) { store.set(`${params[0]}|${params[1]}`, params[2]); return { rows: [], rowCount: 1 }; }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) { const v = store.get(`${params[0]}|${params[1]}`); return { rows: v ? [{ enc_value: v }] : [] }; }
      if (/DELETE FROM account_secrets/i.test(sql)) { store.delete(`${params[0]}|${params[1]}`); return { rows: [], rowCount: 1 }; }
      return { rows: [] };
    },
  };
}

const realFetch = globalThis.fetch;
let refreshCalls = 0;
beforeEach(() => {
  store = new Map();
  refreshCalls = 0;
  __setPoolForTest(memPool() as never);
  __clearGoogleTokenCache();
  globalThis.fetch = (async () => {
    refreshCalls++;
    return new Response(JSON.stringify({ access_token: "at-" + refreshCalls, expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  __setPoolForTest(null);
  globalThis.fetch = realFetch;
});

test("refresh + cache: segunda chamada não bate na rede de novo", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r", scopes: [] });
  const t1 = await getGoogleAccessTokenFor("acc:1", "a@gmail.com");
  const t2 = await getGoogleAccessTokenFor("acc:1", "a@gmail.com");
  assert.equal(t1, "at-1");
  assert.equal(t2, "at-1"); // veio do cache
  assert.equal(refreshCalls, 1);
});

test("conta inexistente erra claro", async () => {
  await assert.rejects(() => getGoogleAccessTokenFor("acc:1", "nao@existe.com"), /não conectada/);
});

test("isolamento: conta B não resolve um ref de agenda da conta A", async () => {
  await addGoogleAccount("acc:A", { email: "x@gmail.com", refresh_token: "rA", scopes: [] });
  const ref = encodeCalendarRef("x@gmail.com", "primary");
  await assert.rejects(() => resolveCalendarRef("acc:B", ref), /não pertence/);
  // a própria conta A resolve normalmente:
  const r = await resolveCalendarRef("acc:A", ref);
  assert.equal(r.email, "x@gmail.com");
  assert.equal(r.calendarId, "primary");
  assert.equal(r.token, "at-1");
});
