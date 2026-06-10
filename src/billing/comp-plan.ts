// src/billing/comp-plan.ts
// Operator-only helpers for granting and revoking courtesy ("comp") access to
// the "ilimitado" plan without a Stripe subscription.
//
// Rules:
//   grantCompPlan(accountId, plan='ilimitado')
//     — sets plan=<plan>, plan_comp=true, plan_status='comp'.
//     — refuses with CompGrantError when the account kind='owner' (already
//       unlimited; no-op would be misleading).
//   revokeCompPlan(accountId)
//     — only acts when plan_comp=true; resets plan='free', plan_comp=false,
//       plan_status=null.
//     — ignores accounts with plan_comp=false (Stripe-paying customers are
//       protected; their plan is managed by Stripe, not by this helper).
//
// Security: accountId always comes from the operator admin path (BEARER_TOKEN
// gated); it is never derived from user-supplied input.
//
// Auditability: every grant/revoke writes a structured log line to stdout so
// it shows up in PM2 logs.
import { getPool } from "../rag/storage.js";
import { __clearPlanCache } from "./account-plan.js";
import type { PlanId } from "./plans.js";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class CompGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompGrantError";
  }
}

// ---------------------------------------------------------------------------
// Internal: read the columns we need from a single account row
// ---------------------------------------------------------------------------

interface AccountKindCompRow {
  kind: string | null;
  plan_comp: boolean;
  plan: string | null;
}

async function getAccountRow(accountId: string): Promise<AccountKindCompRow | null> {
  const p = getPool();
  const { rows } = await p.query<AccountKindCompRow>(
    `SELECT kind, plan_comp, plan FROM account WHERE id=$1`,
    [accountId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// grantCompPlan
// ---------------------------------------------------------------------------

/**
 * Grant courtesy access to `plan` (default: 'ilimitado') for a friend account.
 *
 * Throws CompGrantError when:
 *   - the account does not exist.
 *   - the account kind is 'owner' (already has unlimited access).
 *
 * Sets plan=<plan>, plan_comp=true, plan_status='comp'.
 * Busts the plan cache so enforcement sees the new plan immediately.
 */
export async function grantCompPlan(
  accountId: string,
  plan: PlanId = "ilimitado",
): Promise<void> {
  const row = await getAccountRow(accountId);
  if (!row) {
    throw new CompGrantError(`Conta não encontrada: ${accountId}`);
  }
  if (row.kind === "owner") {
    throw new CompGrantError(
      `Conta owner já tem acesso ilimitado. Nenhuma ação necessária para: ${accountId}`,
    );
  }

  const p = getPool();
  await p.query(
    `UPDATE account SET plan=$2, plan_comp=true, plan_status='comp' WHERE id=$1`,
    [accountId, plan],
  );
  __clearPlanCache();

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      action: "comp_grant",
      account_id: accountId,
      plan,
    }),
  );
}

// ---------------------------------------------------------------------------
// revokeCompPlan
// ---------------------------------------------------------------------------

/**
 * Revoke courtesy access from an account.
 *
 * Only acts when plan_comp=true. If plan_comp=false the account is either:
 *   - a paying Stripe customer (managed by webhook; must not touch), or
 *   - already on free (no-op).
 *
 * Resets plan='free', plan_comp=false, plan_status=null.
 * Busts the plan cache so enforcement sees the revocation immediately.
 *
 * Returns true when the account was revoked, false when it was not comp.
 */
export async function revokeCompPlan(accountId: string): Promise<boolean> {
  const row = await getAccountRow(accountId);
  if (!row || !row.plan_comp) {
    // Not comp — ignore (protects Stripe-paying customers).
    return false;
  }

  const p = getPool();
  await p.query(
    `UPDATE account SET plan='free', plan_comp=false, plan_status=null WHERE id=$1`,
    [accountId],
  );
  __clearPlanCache();

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      action: "comp_revoke",
      account_id: accountId,
    }),
  );

  return true;
}
