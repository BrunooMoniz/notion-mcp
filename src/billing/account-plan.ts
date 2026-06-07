// src/billing/account-plan.ts
// Per-account plan/billing row: read (with a short cache, mirroring
// account-bearer.ts) + the write paths the Stripe webhook needs. The plan is
// always resolved server-side from account_id; it never comes from user input.
import { getPool, hasInjectedPool } from "../rag/storage.js";

export interface BillingRow {
  plan: string;
  plan_status: string | null;
  current_period_end: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

const TTL_MS = 60_000;
const cache = new Map<string, { plan: string; exp: number }>();

/** Test/ops hook: drop the plan cache so a plan change takes effect immediately. */
export function __clearPlanCache(): void {
  cache.clear();
}

/** The account's plan id (e.g. 'free'|'pro'|'owner'). Missing row -> 'free'.
 *  Cached for TTL_MS; busted on any plan write. No DB? -> 'free' (light dev). */
export async function getAccountPlan(accountId: string): Promise<string> {
  const c = cache.get(accountId);
  if (c && c.exp > Date.now()) return c.plan;
  if (c) cache.delete(accountId);
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return "free";
  const p = getPool();
  const { rows } = await p.query<{ plan: string }>(`SELECT plan FROM account WHERE id=$1`, [accountId]);
  const plan = rows[0]?.plan ?? "free";
  cache.set(accountId, { plan, exp: Date.now() + TTL_MS });
  return plan;
}

export async function getBillingRow(accountId: string): Promise<BillingRow | null> {
  const p = getPool();
  const { rows } = await p.query<BillingRow>(
    `SELECT plan, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id
       FROM account WHERE id=$1`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function setStripeCustomerId(accountId: string, customerId: string): Promise<void> {
  const p = getPool();
  await p.query(`UPDATE account SET stripe_customer_id=$2 WHERE id=$1`, [accountId, customerId]);
  cache.delete(accountId);
}

export async function accountIdForCustomer(customerId: string): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ id: string }>(`SELECT id FROM account WHERE stripe_customer_id=$1`, [customerId]);
  return rows[0]?.id ?? null;
}

/** Webhook write: set plan/status/subscription by Stripe customer id. Returns the
 *  updated account id (or null if no account maps to this customer). Busts cache. */
export async function applySubscriptionState(s: {
  customerId: string;
  plan: string;
  status: string | null;
  subscriptionId: string | null;
  currentPeriodEnd: Date | null;
}): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ id: string }>(
    `UPDATE account SET plan=$2, plan_status=$3, stripe_subscription_id=$4, current_period_end=$5
       WHERE stripe_customer_id=$1 RETURNING id`,
    [s.customerId, s.plan, s.status, s.subscriptionId, s.currentPeriodEnd],
  );
  const id = rows[0]?.id ?? null;
  if (id) cache.delete(id);
  return id;
}

/** Mark an account past_due (invoice.payment_failed). Keeps plan, flips status. */
export async function markPastDue(accountId: string): Promise<void> {
  const p = getPool();
  await p.query(`UPDATE account SET plan_status='past_due' WHERE id=$1`, [accountId]);
  cache.delete(accountId);
}

/** Idempotency: insert the event id. Returns true if NEW (process it), false if
 *  already seen (skip). */
export async function recordBillingEvent(eventId: string, type: string, accountId: string | null): Promise<boolean> {
  const p = getPool();
  const res = await p.query(
    `INSERT INTO billing_events (stripe_event_id, type, account_id) VALUES ($1, $2, $3)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
    [eventId, type, accountId],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Undo recordBillingEvent so a failed handler can be retried by Stripe. */
export async function deleteBillingEvent(eventId: string): Promise<void> {
  const p = getPool();
  await p.query(`DELETE FROM billing_events WHERE stripe_event_id=$1`, [eventId]);
}
