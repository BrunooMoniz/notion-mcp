// src/portal/invites.ts
// 001-account-portal — operator-generated, single-use invite codes. Only the
// SHA-256 hash is stored; the plaintext is printed once by `npm run make-invite`
// and delivered out-of-band. Redemption is an atomic single-winner UPDATE so a
// code can create exactly one account (FR-001, FR-002).
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "../rag/storage.js";

export function generateInviteCode(): string {
  return randomBytes(12).toString("hex"); // 24 hex chars
}

export function hashInvite(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
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
