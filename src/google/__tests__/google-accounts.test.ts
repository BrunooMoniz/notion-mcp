// src/google/__tests__/google-accounts.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64); // vault precisa de chave antes do import

import {
  addGoogleAccount,
  getGoogleAccounts,
  removeGoogleAccount,
  getRefreshToken,
  listGoogleAccountsMasked,
} from "../google-accounts.js";
import { __setPoolForTest } from "../../rag/storage.js";

let store: Map<string, string>; // `${account}|${kind}` -> enc_value

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/DELETE FROM account_secrets/i.test(sql)) {
        store.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
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

test("adiciona duas contas Google; upsert por email (sem duplicar)", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r-a", scopes: ["s"], connected_at: "2026-06-07T00:00:00Z" });
  await addGoogleAccount("acc:1", { email: "b@gmail.com", refresh_token: "r-b", scopes: ["s"], connected_at: "2026-06-07T00:00:00Z" });
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r-a2", scopes: ["s"], connected_at: "2026-06-07T01:00:00Z" }); // reconecta a mesma

  const accounts = await getGoogleAccounts("acc:1");
  assert.equal(accounts.length, 2);
  assert.equal(await getRefreshToken("acc:1", "a@gmail.com"), "r-a2"); // atualizado
});

test("lista mascarada não vaza refresh_token; texto cifrado em repouso", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "super-refresh-xyz", scopes: ["s"] });
  const masked = await listGoogleAccountsMasked("acc:1");
  assert.deepEqual(masked.map((m) => m.email), ["a@gmail.com"]);
  assert.ok(!JSON.stringify(masked).includes("super-refresh-xyz"));

  const enc = store.get("acc:1|google_oauth")!;
  assert.match(enc, /^v1:/); // envelope AES-GCM
  assert.ok(!enc.includes("super-refresh-xyz"));
});

test("isolamento: conta B não vê refresh_token da conta A", async () => {
  await addGoogleAccount("acc:A", { email: "x@gmail.com", refresh_token: "rA", scopes: [] });
  assert.equal(await getRefreshToken("acc:B", "x@gmail.com"), null);
});

test("remover a última conta apaga o segredo", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r", scopes: [] });
  assert.equal(await removeGoogleAccount("acc:1", "a@gmail.com"), true);
  assert.equal((await getGoogleAccounts("acc:1")).length, 0);
  assert.ok(!store.has("acc:1|google_oauth"));
  assert.equal(await removeGoogleAccount("acc:1", "a@gmail.com"), false); // já não existe
});
