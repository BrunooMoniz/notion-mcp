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

// --- Login code (OTP) — for in-flow auth on the Claude.ai OAuth authorize screen.
// Reuses the magic_links table: the stored token is `code:<email>:<6 digits>`, so
// a code is bound to its email and verified through the same single-use, expiring
// consume path as a link. Codes are short → callers MUST rate-limit verification.
const CODE_TTL_MS = 10 * 60_000;

export function generateLoginCode(): string {
  // 6 digits, zero-padded. Entropy is low by design (typeable) — protected by
  // single-use + short expiry + caller-side attempt limiting.
  return String(Math.floor(parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000)).padStart(6, "0");
}

function codeToken(email: string, code: string): string {
  return `code:${email}:${code}`;
}

/** Issue a login code for an existing account's email. Returns the 6-digit code
 *  to email. Supersedes the email's prior unconsumed links/codes. */
export async function issueLoginCode(
  email: string,
  accountId: string,
  now: Date = new Date(),
  ttlMs: number = CODE_TTL_MS,
): Promise<string> {
  const code = generateLoginCode();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const p = getPool();
  await p.query(`DELETE FROM magic_links WHERE email=$1 AND consumed_at IS NULL`, [email]);
  await p.query(
    `INSERT INTO magic_links (token_hash, email, account_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [hashMagic(codeToken(email, code)), email, accountId, expiresAt],
  );
  return code;
}

/** Verify + consume a login code for an email. Returns the account on success. */
export async function consumeLoginCode(
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<{ email: string; accountId: string | null } | null> {
  if (!email || !/^\d{6}$/.test(code)) return null;
  return consumeMagicLink(codeToken(email, code), now);
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
