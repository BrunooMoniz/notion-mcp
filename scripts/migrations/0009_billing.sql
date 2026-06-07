-- scripts/migrations/0009_billing.sql
-- Applied by the migration runner: npm run migrate
--
-- Fase 3 billing/freemium. Additive + idempotent. Adds the plan/subscription
-- columns to `account` and a `billing_events` table for webhook idempotency.
-- Existing friend rows default to 'free'; the operator 'bruno' becomes 'owner'
-- (the unlimited sentinel) so his behavior is unchanged. Nothing is dropped.

ALTER TABLE account ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE account ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE account ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE account ADD COLUMN IF NOT EXISTS plan_status text;          -- active | past_due | canceled
ALTER TABLE account ADD COLUMN IF NOT EXISTS current_period_end timestamptz;

-- Look up an account by its Stripe customer (webhook path). Partial index: most
-- rows have NULL customer id.
CREATE UNIQUE INDEX IF NOT EXISTS account_stripe_customer_uniq
  ON account (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Owner is unlimited. Idempotent (re-running sets the same value).
UPDATE account SET plan='owner' WHERE id='bruno';

-- Webhook idempotency: one row per processed Stripe event id.
CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id text PRIMARY KEY,
  type            text NOT NULL,
  account_id      text,
  received_at     timestamptz NOT NULL DEFAULT now()
);
