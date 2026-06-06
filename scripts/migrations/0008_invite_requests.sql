-- scripts/migrations/0008_invite_requests.sql
-- Applied by the migration runner: npm run migrate
--
-- 001-account-portal — "request an invite" leads. A visitor asks for access from
-- the landing page; the operator sees the list in /admin and can generate + email
-- an invite in one click. Additive + idempotent.

CREATE TABLE IF NOT EXISTS invite_requests (
  id               bigserial PRIMARY KEY,
  email            text NOT NULL,
  name             text,
  note             text,
  status           text NOT NULL DEFAULT 'pending',  -- pending | invited
  requested_at     timestamptz NOT NULL DEFAULT now(),
  invited_at       timestamptz,
  invite_code_hash text                              -- sha256 of the issued code (audit)
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_email_uniq ON invite_requests (email);
CREATE INDEX IF NOT EXISTS invite_requests_status_idx ON invite_requests (status, requested_at DESC);
