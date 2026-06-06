// src/portal/accounts.ts
// 001-account-portal — friend account lookup/creation by email. One email maps to
// exactly one account (account.email UNIQUE, migration 0007). Friend accounts are
// namespaced "friend:" so they never collide with 'bruno' or the "notion:" /
// "notion-pat:" identities minted by the standalone Notion onboarding.
import { randomBytes } from "node:crypto";
import { getPool } from "../rag/storage.js";
import { hashInvite } from "./invites.js";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isLikelyEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/** Resolve an email to its account id, or null. */
export async function findAccountByEmail(email: string): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ id: string }>(
    `SELECT id FROM account WHERE email=$1`,
    [normalizeEmail(email)],
  );
  return rows[0]?.id ?? null;
}

export function generateFriendAccountId(): string {
  return `friend:${randomBytes(12).toString("hex")}`;
}

/** Create a friend account bound to an email. Pass an explicit id to keep it in
 *  sync with an already-redeemed invite. Returns the account id. */
export async function createFriendAccount(
  email: string,
  id: string = generateFriendAccountId(),
): Promise<string> {
  const p = getPool();
  await p.query(
    `INSERT INTO account (id, kind, status, email) VALUES ($1, 'friend', 'active', $2)`,
    [id, normalizeEmail(email)],
  );
  return id;
}

/**
 * Atomically redeem an unused invite AND create the friend account bound to it,
 * in ONE transaction. Either both happen or neither: if the account INSERT fails
 * (e.g. a concurrent registration won the unique-email race, or a transient DB
 * error), the redeem rolls back so the single-use invite is NOT burned and the
 * friend can retry. Returns "created" on success, "lost-race" if the invite was
 * already used/unknown (no rows updated), and THROWS on a real failure (the
 * caller treats a throw as a generic retryable response, invite intact).
 *
 * Uses a dedicated client (real pg.Pool). Under the test-injected PoolLike
 * (__setPoolForTest, which has no connect()), it falls back to two sequential
 * statements — the atomicity matters only against a real DB.
 */
export async function redeemInviteAndCreateAccount(
  code: string,
  id: string,
  email: string,
): Promise<"created" | "lost-race"> {
  const pool = getPool();
  const redeemSql = `UPDATE invite_codes SET redeemed_at=now(), redeemed_account_id=$2
                     WHERE code_hash=$1 AND redeemed_at IS NULL`;
  const insertSql = `INSERT INTO account (id, kind, status, email)
                     VALUES ($1, 'friend', 'active', $2)`;
  const redeemParams = [hashInvite(code), id];
  const insertParams = [id, normalizeEmail(email)];

  // Test path: injected PoolLike has no connect() — run sequentially.
  if (typeof pool.connect !== "function") {
    const r = await pool.query(redeemSql, redeemParams);
    if ((r.rowCount ?? 0) !== 1) return "lost-race";
    await pool.query(insertSql, insertParams);
    return "created";
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(redeemSql, redeemParams);
    if ((r.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return "lost-race";
    }
    await client.query(insertSql, insertParams);
    await client.query("COMMIT");
    return "created";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** True iff the account has at least one connected Notion workspace. */
export async function hasNotionWorkspace(accountId: string): Promise<boolean> {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT 1 FROM account_workspaces WHERE account_id=$1 LIMIT 1`,
    [accountId],
  );
  return rows.length > 0;
}

/** The email on an account, or null. */
export async function getAccountEmail(accountId: string): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ email: string | null }>(
    `SELECT email FROM account WHERE id=$1`,
    [accountId],
  );
  return rows[0]?.email ?? null;
}
