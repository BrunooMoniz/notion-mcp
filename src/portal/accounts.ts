// src/portal/accounts.ts
// 001-account-portal — friend account lookup/creation by email. One email maps to
// exactly one account (account.email UNIQUE, migration 0007). Friend accounts are
// namespaced "friend:" so they never collide with 'bruno' or the "notion:" /
// "notion-pat:" identities minted by the standalone Notion onboarding.
import { randomBytes } from "node:crypto";
import { getPool } from "../rag/storage.js";

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
