-- 0014_plan_comp.sql
-- Marks accounts whose "ilimitado" plan was granted manually by the operator
-- (courtesy / comp access, no Stripe subscription). Additive and idempotent.
ALTER TABLE account ADD COLUMN IF NOT EXISTS plan_comp boolean NOT NULL DEFAULT false;
