// src/rag/__tests__/secrets.test.ts
// F3.1 — per-account secret vault (AES-256-GCM). Crypto is pure; the DB CRUD is
// tested via the __setPoolForTest stub (no live DB). Asserts: roundtrip, tamper
// detection, IV uniqueness, key validation, and that stored values are
// ciphertext (never plaintext).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret,
  decryptSecret,
  getSecretsKey,
  setAccountSecret,
  getAccountSecret,
} from "../../secrets.js";
import { __setPoolForTest } from "../storage.js";

const KEY = Buffer.from("ab".repeat(32), "hex"); // 32 bytes, test-only
const HEXKEY = "ab".repeat(32);

afterEach(() => __setPoolForTest(null));

test("encrypt/decrypt roundtrip recovers the plaintext", () => {
  const blob = encryptSecret("ntn_supersecret_token", KEY);
  assert.equal(decryptSecret(blob, KEY), "ntn_supersecret_token");
});

test("blob is the versioned envelope and does NOT contain the plaintext", () => {
  const blob = encryptSecret("ntn_plaintext_marker", KEY);
  assert.match(blob, /^v1:/);
  assert.equal(blob.split(":").length, 4);
  assert.doesNotMatch(blob, /ntn_plaintext_marker/);
});

test("same plaintext encrypts to different blobs (random IV)", () => {
  const a = encryptSecret("same", KEY);
  const b = encryptSecret("same", KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY), "same");
  assert.equal(decryptSecret(b, KEY), "same");
});

test("tampered ciphertext fails the GCM auth tag", () => {
  const blob = encryptSecret("secret", KEY);
  const parts = blob.split(":");
  const ct = Buffer.from(parts[3], "base64");
  ct[0] ^= 0xff; // flip a bit
  parts[3] = ct.toString("base64");
  assert.throws(() => decryptSecret(parts.join(":"), KEY));
});

test("wrong key cannot decrypt", () => {
  const blob = encryptSecret("secret", KEY);
  const otherKey = Buffer.from("cd".repeat(32), "hex");
  assert.throws(() => decryptSecret(blob, otherKey));
});

test("malformed / unknown-version envelope throws", () => {
  assert.throws(() => decryptSecret("not-a-blob", KEY));
  assert.throws(() => decryptSecret("v2:a:b:c", KEY));
});

test("getSecretsKey validates SECRETS_KEY", () => {
  const prev = process.env.SECRETS_KEY;
  try {
    delete process.env.SECRETS_KEY;
    assert.throws(() => getSecretsKey(), /not set/);
    process.env.SECRETS_KEY = "tooshort";
    assert.throws(() => getSecretsKey(), /64 hex/);
    process.env.SECRETS_KEY = HEXKEY;
    const k = getSecretsKey();
    assert.equal(k.length, 32);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = prev;
  }
});

test("setAccountSecret stores ciphertext (not plaintext), upsert on (account_id, kind)", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [], rowCount: 1 };
    },
  } as never);
  const prev = process.env.SECRETS_KEY;
  process.env.SECRETS_KEY = HEXKEY;
  try {
    await setAccountSecret("acme", "notion_pat:personal", "ntn_live_token");
  } finally {
    if (prev === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = prev;
  }
  assert.match(sql, /INSERT INTO account_secrets/i);
  assert.match(sql, /ON CONFLICT \(account_id, kind\)/i);
  assert.equal(params[0], "acme");
  assert.equal(params[1], "notion_pat:personal");
  assert.match(String(params[2]), /^v1:/); // encrypted envelope
  assert.doesNotMatch(String(params[2]), /ntn_live_token/); // never plaintext
});

test("getAccountSecret decrypts the stored value; null when absent", async () => {
  const prev = process.env.SECRETS_KEY;
  process.env.SECRETS_KEY = HEXKEY;
  try {
    const stored = encryptSecret("ntn_roundtrip", getSecretsKey());
    __setPoolForTest({
      query: async () => ({ rows: [{ enc_value: stored }], rowCount: 1 }),
    } as never);
    assert.equal(await getAccountSecret("acme", "notion_pat:personal"), "ntn_roundtrip");

    __setPoolForTest({ query: async () => ({ rows: [], rowCount: 0 }) } as never);
    assert.equal(await getAccountSecret("acme", "missing"), null);

    // A tampered stored blob must THROW end-to-end (never return garbage).
    const tampered = encryptSecret("ntn_x", getSecretsKey()).slice(0, -4) + "AAAA";
    __setPoolForTest({
      query: async () => ({ rows: [{ enc_value: tampered }], rowCount: 1 }),
    } as never);
    await assert.rejects(() => getAccountSecret("acme", "notion_pat:personal"));
  } finally {
    if (prev === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = prev;
  }
});
