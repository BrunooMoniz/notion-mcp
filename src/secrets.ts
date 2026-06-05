// src/secrets.ts
// F3.1 — per-account secret vault. AES-256-GCM (Node `crypto`, zero deps) over
// the account_secrets table (migration 0005), keyed by (account_id, kind), e.g.
// kind = "notion_pat:personal" | "granola:personal" | "ical".
//
// Behavior-preserving: the single current account ('bruno') keeps reading its
// tokens from .env (clients.ts is untouched). This vault is the storage path for
// FUTURE onboarded accounts (F3.2) whose secrets must NOT live in .env. Plaintext
// secrets are never logged. Encryption key comes from SECRETS_KEY (64 hex chars =
// 32 bytes); generate with `openssl rand -hex 32`.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getPool } from "./rag/storage.js";

const IV_BYTES = 12; // GCM standard nonce size
const FORMAT = "v1"; // versioned envelope so the scheme can evolve

/** Resolve the 32-byte AES key from SECRETS_KEY (64 hex chars). Throws if absent
 *  or malformed — callers that touch the vault must have a key configured. */
export function getSecretsKey(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error(
      "SECRETS_KEY not set — need 64 hex chars (32 bytes). Generate: openssl rand -hex 32",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("SECRETS_KEY must be exactly 64 hex characters (32 bytes)");
  }
  return Buffer.from(raw, "hex");
}

/** Encrypt a UTF-8 secret → "v1:<iv_b64>:<tag_b64>:<ct_b64>". Random IV per call,
 *  so the same plaintext never produces the same blob. */
export function encryptSecret(plaintext: string, key: Buffer = getSecretsKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Decrypt a blob produced by encryptSecret. Throws on tamper (GCM auth) or a
 *  malformed/unknown-version envelope. */
export function decryptSecret(blob: string, key: Buffer = getSecretsKey()): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new Error("malformed secret blob");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Store (encrypted) a secret for an account. Upsert on (account_id, kind). */
export async function setAccountSecret(
  accountId: string,
  kind: string,
  plaintext: string,
): Promise<void> {
  const enc = encryptSecret(plaintext);
  const p = getPool();
  await p.query(
    `INSERT INTO account_secrets (account_id, kind, enc_value) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, kind) DO UPDATE SET enc_value = EXCLUDED.enc_value`,
    [accountId, kind, enc],
  );
}

/** Fetch + decrypt a secret for an account, or null if not stored. */
export async function getAccountSecret(accountId: string, kind: string): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ enc_value: string }>(
    `SELECT enc_value FROM account_secrets WHERE account_id=$1 AND kind=$2`,
    [accountId, kind],
  );
  if (!rows[0]) return null;
  return decryptSecret(rows[0].enc_value);
}
