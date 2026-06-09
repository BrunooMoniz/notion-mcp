// src/portal/invites.ts
// 001-account-portal — operator-generated, single-use invite codes. Only the
// SHA-256 hash is stored; the plaintext is printed once by `npm run make-invite`
// and delivered out-of-band. Redemption is an atomic single-winner UPDATE so a
// code can create exactly one account (FR-001, FR-002).
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "../rag/storage.js";

/**
 * Safe charset for ZIN invite codes: uppercase alphanumeric minus visually
 * ambiguous characters 0/O/1/I/L. 32 symbols.
 * Bias note: 256 % 32 === 0, so every byte maps cleanly to the charset with
 * zero modulo bias. We keep rejection sampling (threshold = 256 - (256 % 32))
 * as a future-proof guard for charset size changes.
 */
const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CHARSET_LEN = CHARSET.length; // 32

function randomCodeChars(n: number): string {
  let result = "";
  // Over-request bytes to amortize rejections; 3× is more than enough for 8 chars.
  while (result.length < n) {
    const buf = randomBytes(n * 3);
    for (let i = 0; i < buf.length && result.length < n; i++) {
      // Reject bytes that would introduce modulo bias.
      // 256 % 32 === 0, so actually NO bias — every byte maps cleanly.
      // Keeping rejection sampling for clarity and future charset changes.
      const threshold = 256 - (256 % CHARSET_LEN);
      if (buf[i] < threshold) {
        result += CHARSET[buf[i] % CHARSET_LEN];
      }
    }
  }
  return result;
}

/** Generate a new invite code in ZIN-XXXX-XXXX format using the safe charset. */
export function generateInviteCode(): string {
  const part1 = randomCodeChars(4);
  const part2 = randomCodeChars(4);
  return `ZIN-${part1}-${part2}`;
}

/**
 * Normalize an invite code before hashing.
 *
 * New ZIN codes: strip optional ZIN prefix (case-insensitive), remove hyphens
 * and spaces, uppercase. ZIN-ABCD-2345 → ABCD2345.
 *
 * Legacy codes (24-char hex): pass through unchanged after trim. The regex
 * for ZIN detection is /^ZIN[\s-]?/i — only matches if the string starts
 * with ZIN (after whitespace). Codes that don't start with ZIN pass through.
 */
export function normalizeInviteCode(code: string): string {
  const trimmed = code.trim();
  // Check if it starts with ZIN (optionally followed by - or space)
  if (/^ZIN[\s-]?/i.test(trimmed)) {
    // Strip the ZIN prefix, then remove all hyphens/spaces, uppercase.
    return trimmed.replace(/^ZIN[\s-]?/i, "").replace(/[\s-]/g, "").toUpperCase();
  }
  return trimmed;
}

export function hashInvite(code: string): string {
  return createHash("sha256").update(normalizeInviteCode(code)).digest("hex");
}

/** Store a new invite (hash only). Idempotent on the hash. */
export async function issueInvite(code: string, label?: string): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO invite_codes (code_hash, label) VALUES ($1, $2)
     ON CONFLICT (code_hash) DO NOTHING`,
    [hashInvite(code), label ?? null],
  );
}

/** True iff the code exists and is still unused. Does NOT consume it. */
export async function isInviteValid(code: string): Promise<boolean> {
  if (!code || !code.trim()) return false;
  const p = getPool();
  const { rows } = await p.query(
    `SELECT 1 FROM invite_codes WHERE code_hash=$1 AND redeemed_at IS NULL`,
    [hashInvite(code)],
  );
  return rows.length > 0;
}

/** Atomically redeem an unused code, binding it to accountId. Returns true only
 *  for the single caller that consumed it; false for unknown/already-used. */
export async function redeemInvite(
  code: string,
  accountId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!code || !code.trim()) return false;
  const p = getPool();
  const res = await p.query(
    `UPDATE invite_codes SET redeemed_at=$2, redeemed_account_id=$3
     WHERE code_hash=$1 AND redeemed_at IS NULL`,
    [hashInvite(code), now, accountId],
  );
  return (res.rowCount ?? 0) === 1;
}
