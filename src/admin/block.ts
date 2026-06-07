// src/admin/block.ts
// Objective #6 — operator block/unblock actions. Factored out of routes.ts so the
// mutating logic (status flip + bearer revocation + cache bust + audit) is unit-
// testable with an injected pool, independent of Express.
//
// Operator-gated (the route applies the same BEARER_TOKEN gate as the rest of
// /admin). The account_id to act ON comes from the request body — that's allowed
// here precisely because the action is operator-gated and is ABOUT another account
// (unlike user-scoped reads, which must derive scope from server-side context).
import { getPool } from "../rag/storage.js";
import { revokeBearersForAccount } from "../account-bearer.js";
import { bustAccountStatus, ACTIVE_STATUS, SUSPENDED_STATUS } from "../account-status.js";
import { auditWrite } from "../audit.js";

export interface BlockResult {
  /** false when no account row matched the id (operator typo / stale row). */
  found: boolean;
  /** Number of per-account bearers revoked (block only). */
  revoked: number;
}

/** Suspend an account: status='suspended', revoke its MCP bearers, bust the
 *  status cache (so the /mcp guard sees it within the request, not after TTL),
 *  and audit. Mutating => auditWrite. */
export async function blockAccount(accountId: string): Promise<BlockResult> {
  const p = getPool();
  const res = await p.query(
    `UPDATE account SET status=$2 WHERE id=$1`,
    [accountId, SUSPENDED_STATUS],
  );
  const found = (res.rowCount ?? 0) > 0;
  let revoked = 0;
  if (found) {
    revoked = await revokeBearersForAccount(accountId);
    bustAccountStatus(accountId);
  }
  auditWrite("admin_block", "*", { account: accountId }, { found, revoked });
  return { found, revoked };
}

/** Reactivate an account: status='active', bust the status cache, audit. Does NOT
 *  re-issue bearers (the user mints a fresh one via the portal). */
export async function unblockAccount(accountId: string): Promise<BlockResult> {
  const p = getPool();
  const res = await p.query(
    `UPDATE account SET status=$2 WHERE id=$1`,
    [accountId, ACTIVE_STATUS],
  );
  const found = (res.rowCount ?? 0) > 0;
  if (found) bustAccountStatus(accountId);
  auditWrite("admin_unblock", "*", { account: accountId }, { found });
  return { found, revoked: 0 };
}
