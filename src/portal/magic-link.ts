// src/portal/magic-link.ts
// 001-account-portal — single-use, short-lived magic sign-in tokens. Hash at
// rest; the plaintext travels only in the emailed URL. Issuing a new link for an
// email invalidates that email's prior unconsumed links (FR-004). Verify+consume
// is one atomic UPDATE so a link works exactly once.
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "../rag/storage.js";

export const MAGIC_TTL_MS = 15 * 60_000; // 15 minutes

export function generateMagicToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashMagic(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issue a single-use link token for an email (and its resolved account, if any).
 *  Supersedes the email's prior unconsumed links. Returns the plaintext token. */
export async function issueMagicLink(
  email: string,
  accountId: string | null,
  now: Date = new Date(),
  ttlMs: number = MAGIC_TTL_MS,
): Promise<string> {
  const token = generateMagicToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const p = getPool();
  await p.query(`DELETE FROM magic_links WHERE email=$1 AND consumed_at IS NULL`, [email]);
  await p.query(
    `INSERT INTO magic_links (token_hash, email, account_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashMagic(token), email, accountId, expiresAt],
  );
  return token;
}

/** Verify + consume a token atomically. Returns { email, accountId } on success,
 *  null if unknown, already consumed, or expired. */
export async function consumeMagicLink(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<{ email: string; accountId: string | null } | null> {
  if (!token) return null;
  const p = getPool();
  const { rows } = await p.query<{ email: string; account_id: string | null }>(
    `UPDATE magic_links SET consumed_at=$2
     WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at > $2
     RETURNING email, account_id`,
    [hashMagic(token), now],
  );
  if (!rows[0]) return null;
  return { email: rows[0].email, accountId: rows[0].account_id };
}
