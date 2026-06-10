// src/portal/account-deletion.ts
// LGPD compliance: delete an account and ALL its associated data in a single
// ordered sequence. Called from POST /portal/delete-account.
// Returns a record of table -> rowCount for audit/reporting.
import { getPool } from "../rag/storage.js";
import { getStripe } from "../billing/stripe.js";

export interface DeletionCounts {
  chunk_feedback: number;
  entities: number;
  brain_facts: number;
  brain_chunks: number;
  account_secrets: number;
  account_api_tokens: number;
  account_workspaces: number;
  portal_sessions: number;
  magic_links: number;
  usage_log: number;
  sync_state: number;
  status_runs: number;
  billing_events: number;
  invite_requests: number;
  account: number;
}

/**
 * Delete an account and ALL its associated data. The Stripe subscription
 * (if any) is cancelled first (best-effort). If Stripe fails, we log the
 * error and proceed with local deletion — the operator must reconcile in Stripe.
 *
 * entity_mentions rows are cascade-deleted when their parent entities rows are
 * deleted (ON DELETE CASCADE FK), so no explicit delete for entity_mentions.
 *
 * Returns per-table row counts for audit purposes.
 */
export async function deleteAccountCompletely(accountId: string): Promise<DeletionCounts> {
  const p = getPool();

  // 1. Fetch the account's email and stripe_subscription_id before deleting.
  const { rows: acctRows } = await p.query<{ email: string | null; stripe_subscription_id: string | null }>(
    `SELECT email, stripe_subscription_id FROM account WHERE id=$1`,
    [accountId],
  );
  const email = acctRows[0]?.email ?? null;
  const stripeSubId = acctRows[0]?.stripe_subscription_id ?? null;

  // 2. Cancel Stripe subscription (best-effort).
  if (stripeSubId) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(stripeSubId);
      console.log(`[account-deletion] Stripe subscription ${stripeSubId} cancelled for ${accountId}`);
    } catch (err: any) {
      console.error(
        `[account-deletion] Stripe cancel failed for ${accountId} (${stripeSubId}): ${err?.message ?? err}. Proceeding with local deletion.`,
      );
    }
  }

  // Helper that runs a DELETE and returns the rowCount.
  async function del(sql: string, params: any[]): Promise<number> {
    const r = await p.query(sql, params);
    return (r.rowCount ?? 0) as number;
  }

  // 3. Delete in dependency order (child tables first, then the account row).
  //    entity_mentions cascade-deleted with entities via ON DELETE CASCADE.
  const counts: DeletionCounts = {
    chunk_feedback:     await del(`DELETE FROM chunk_feedback WHERE account_id=$1`, [accountId]),
    entities:           await del(`DELETE FROM entities WHERE account_id=$1`, [accountId]),
    brain_facts:        await del(`DELETE FROM brain_facts WHERE account_id=$1`, [accountId]),
    brain_chunks:       await del(`DELETE FROM brain_chunks WHERE account_id=$1`, [accountId]),
    account_secrets:    await del(`DELETE FROM account_secrets WHERE account_id=$1`, [accountId]),
    account_api_tokens: await del(`DELETE FROM account_api_tokens WHERE account_id=$1`, [accountId]),
    account_workspaces: await del(`DELETE FROM account_workspaces WHERE account_id=$1`, [accountId]),
    portal_sessions:    await del(`DELETE FROM portal_sessions WHERE account_id=$1`, [accountId]),
    magic_links:        await del(`DELETE FROM magic_links WHERE account_id=$1`, [accountId]),
    usage_log:          await del(`DELETE FROM usage_log WHERE account_id=$1`, [accountId]),
    sync_state:         await del(`DELETE FROM sync_state WHERE account_id=$1`, [accountId]),
    status_runs:        await del(`DELETE FROM status_runs WHERE account_id=$1`, [accountId]),
    billing_events:     await del(`DELETE FROM billing_events WHERE account_id=$1`, [accountId]),
    invite_requests:    email
      ? await del(`DELETE FROM invite_requests WHERE email=$1`, [email])
      : 0,
    account:            await del(`DELETE FROM account WHERE id=$1`, [accountId]),
  };

  console.log(`[account-deletion] Deleted account ${accountId}:`, counts);
  return counts;
}
