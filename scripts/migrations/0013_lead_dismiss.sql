-- scripts/migrations/0013_lead_dismiss.sql
-- Additive + idempotent. Adds a nullable dismissed_at column to invite_requests
-- so the operator can dismiss a lead without sending an invite (preserves history).

ALTER TABLE invite_requests ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

-- Allow filtering dismissed leads separately from pending/invited.
CREATE INDEX IF NOT EXISTS invite_requests_dismissed_idx ON invite_requests (dismissed_at) WHERE dismissed_at IS NOT NULL;
