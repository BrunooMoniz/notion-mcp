// src/portal/__tests__/first-index-notify.test.ts
// notifyFirstIndexDone: envia UMA vez por conta, só quando indexou algo.
import { test } from "node:test";
import assert from "node:assert/strict";

import { notifyFirstIndexDone, type FirstIndexNotifyDeps } from "../first-index-notify.js";

function makeDeps(overrides: Partial<FirstIndexNotifyDeps> = {}) {
  const vault = new Map<string, string>();
  const sent: Array<{ to: string; documents: number; chunks: number }> = [];
  const deps: FirstIndexNotifyDeps = {
    getAccountSecret: async (acct, kind) => vault.get(`${acct}:${kind}`) ?? null,
    setAccountSecret: async (acct, kind, value) => void vault.set(`${acct}:${kind}`, value),
    getAccountEmail: async () => "amigo@example.com",
    sendEmail: async (to, totals) => void sent.push({ to, ...totals }),
    ...overrides,
  };
  return { deps, vault, sent };
}

test("first successful index → sends one email and flags the vault", async () => {
  const { deps, vault, sent } = makeDeps();
  const ok = await notifyFirstIndexDone("acct-1", { documents: 10, chunks: 40 }, deps);
  assert.equal(ok, true);
  assert.deepEqual(sent, [{ to: "amigo@example.com", documents: 10, chunks: 40 }]);
  assert.ok(vault.get("acct-1:first_index_notified"));
});

test("second index → no email (vault flag set)", async () => {
  const { deps, sent } = makeDeps();
  await notifyFirstIndexDone("acct-1", { documents: 10, chunks: 40 }, deps);
  const again = await notifyFirstIndexDone("acct-1", { documents: 12, chunks: 50 }, deps);
  assert.equal(again, false);
  assert.equal(sent.length, 1);
});

test("empty run (0 docs, 0 chunks) → no email, no flag", async () => {
  const { deps, vault, sent } = makeDeps();
  const ok = await notifyFirstIndexDone("acct-1", { documents: 0, chunks: 0 }, deps);
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
  assert.equal(vault.has("acct-1:first_index_notified"), false);
});

test("account without email → no email, no crash", async () => {
  const { deps, sent } = makeDeps({ getAccountEmail: async () => null });
  const ok = await notifyFirstIndexDone("acct-1", { documents: 5, chunks: 10 }, deps);
  assert.equal(ok, false);
  assert.equal(sent.length, 0);
});

test("send failure → returns false, never throws (flag stays to avoid dup)", async () => {
  const { deps } = makeDeps({
    sendEmail: async () => {
      throw new Error("resend down");
    },
  });
  const ok = await notifyFirstIndexDone("acct-1", { documents: 5, chunks: 10 }, deps);
  assert.equal(ok, false);
});
