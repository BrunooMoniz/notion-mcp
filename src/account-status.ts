// src/account-status.ts
// Objective #6 — account suspension enforcement on the /mcp auth path. An operator
// can BLOCK a user (account.status='suspended'); every token that carries an
// accountId (OAuth friend token AND acct_ per-account bearer) is checked here AFTER
// the tenant resolves, and rejected (403) when the account is not active.
//
// Fail-closed: a token that CLAIMS an account whose row is missing/unreadable is
// treated as NOT allowed, so a deleted/unknown account can never slip through.
//
// Caching mirrors account-plan.ts / account-bearer.ts: a short in-memory TTL so we
// don't hit Postgres on every single request, while a block still takes effect
// within TTL_MS without a restart. The block route also busts the cache eagerly.
import { getPool } from "./rag/storage.js";

/** Canonical account statuses. 'active' is the default (migration 0005);
 *  'suspended' is set by the operator block action. Anything else is treated as
 *  not-allowed (fail-closed) so an unexpected value never grants access. */
export const ACTIVE_STATUS = "active";
export const SUSPENDED_STATUS = "suspended";

/**
 * Pure classifier (no DB) — the single source of truth for "is this account
 * allowed to use the API?". Unit-testable without a server or Postgres.
 * Fail-closed: null/undefined/unknown status => false.
 */
export function isAccountAllowed(status: string | null | undefined): boolean {
  return status === ACTIVE_STATUS;
}

const TTL_MS = 30_000;
const cache = new Map<string, { status: string | null; exp: number }>();

/** Test/ops hook: drop the status cache so a block/unblock takes effect now. */
export function __clearStatusCache(): void {
  cache.clear();
}

/** Eagerly bust ONE account (called by block/unblock so the change is instant). */
export function bustAccountStatus(accountId: string): void {
  cache.delete(accountId);
}

/**
 * Resolve an account's status (cached for TTL_MS). Returns the raw status string,
 * or null when the row is missing — the caller passes that to isAccountAllowed(),
 * which fails closed on null. A DB error PROPAGATES (the middleware denies on
 * throw); we never cache an error as "allowed".
 */
export async function getAccountStatus(accountId: string): Promise<string | null> {
  const c = cache.get(accountId);
  if (c && c.exp > Date.now()) return c.status;
  if (c) cache.delete(accountId); // expired; recompute below
  const p = getPool();
  const { rows } = await p.query<{ status: string | null }>(
    `SELECT status FROM account WHERE id=$1`,
    [accountId],
  );
  const status = rows[0]?.status ?? null; // missing row -> null -> not allowed
  cache.set(accountId, { status, exp: Date.now() + TTL_MS });
  return status;
}

/**
 * Convenience used by the /mcp middleware: true iff the account exists AND is
 * active. Fail-closed on a missing row. Throws only on a DB failure (the caller
 * denies the request on throw — never fail open).
 */
export async function isAccountActive(accountId: string): Promise<boolean> {
  return isAccountAllowed(await getAccountStatus(accountId));
}
