// src/portal/__tests__/sources.test.ts
// Source credentials: iCal array add/edit/remove, Granola set/rotate/remove,
// masked reads, and ciphertext at rest (the vault never stores plaintext).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Vault needs a key before secrets.ts is exercised.
process.env.SECRETS_KEY = "0".repeat(64);

import {
  addIcalLink,
  updateIcalLink,
  removeIcalLink,
  listIcalMasked,
  getIcalLinks,
  setGranolaKey,
  getGranolaMasked,
  removeGranolaKey,
  maskUrl,
} from "../sources.js";
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

const SECRET_URL = "https://calendar.google.com/calendar/ical/secret-token-xyz/basic.ics";

test("maskUrl hides the path but keeps host", () => {
  const m = maskUrl(SECRET_URL);
  assert.match(m, /^https:\/\/calendar\.google\.com\//);
  assert.ok(!m.includes("secret-token-xyz"));
});

test("add two iCal links: persisted, listed masked, ciphertext at rest", async () => {
  const id1 = await addIcalLink("friend:1", { url: SECRET_URL, label: "Pessoal", workspace: "personal" });
  const id2 = await addIcalLink("friend:1", { url: SECRET_URL + "2", label: "Trabalho" });
  assert.match(id1, /^[0-9a-f]{8}$/);
  assert.notEqual(id1, id2);

  const links = await getIcalLinks("friend:1");
  assert.equal(links.length, 2);

  const masked = await listIcalMasked("friend:1");
  assert.equal(masked.length, 2);
  assert.ok(!JSON.stringify(masked).includes("secret-token-xyz")); // never leak the URL

  // Ciphertext at rest: stored value is an AES-GCM envelope, not the plaintext.
  const enc = store.get("friend:1|ical")!;
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes("secret-token-xyz"));
});

test("edit and remove iCal links; removing the last clears the secret", async () => {
  const id = await addIcalLink("friend:1", { url: SECRET_URL, label: "A" });
  assert.equal(await updateIcalLink("friend:1", id, { label: "B" }), true);
  assert.equal((await getIcalLinks("friend:1"))[0].label, "B");
  assert.equal(await updateIcalLink("friend:1", "missing", { label: "C" }), false);

  assert.equal(await removeIcalLink("friend:1", id), true);
  assert.equal((await getIcalLinks("friend:1")).length, 0);
  assert.ok(!store.has("friend:1|ical")); // secret deleted, not left empty
  assert.equal(await removeIcalLink("friend:1", id), false);
});

test("Granola: set, rotate, mask, remove — single value, never plaintext", async () => {
  await setGranolaKey("friend:1", "granola-key-aaaa");
  let g = await getGranolaMasked("friend:1");
  assert.deepEqual(g, { set: true, masked: "••••aaaa" });
  assert.match(store.get("friend:1|granola")!, /^v1:/); // encrypted

  await setGranolaKey("friend:1", "granola-key-bbbb"); // rotate
  g = await getGranolaMasked("friend:1");
  assert.equal(g.masked, "••••bbbb");

  await removeGranolaKey("friend:1");
  assert.deepEqual(await getGranolaMasked("friend:1"), { set: false, masked: null });
});
