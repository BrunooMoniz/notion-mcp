-- scripts/portal-dev-schema.sql
-- DEV ONLY — minimal schema to run the portal locally on a plain Postgres with
-- NO pgvector (the portal tables don't need it). This is NOT the production
-- migration path (that's scripts/migrations/, applied by `npm run migrate`).
-- It creates just the tables the portal touches so you can click through the
-- invite -> magic link -> sign-in -> credentials flow locally.

CREATE TABLE IF NOT EXISTS account (
  id          text PRIMARY KEY,
  kind        text,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  email       text
);
CREATE UNIQUE INDEX IF NOT EXISTS account_email_uniq ON account (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_workspaces (
  account_id  text NOT NULL,
  workspace   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace)
);

CREATE TABLE IF NOT EXISTS account_secrets (
  account_id  text NOT NULL,
  kind        text NOT NULL,
  enc_value   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE IF NOT EXISTS status_runs (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL DEFAULT 'bruno',
  worker      text NOT NULL,
  source      text NOT NULL,
  ok          boolean NOT NULL,
  counts      jsonb,
  error       text,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id    text NOT NULL DEFAULT 'bruno',
  source_type   text NOT NULL,
  last_sync_at  timestamptz NOT NULL,
  PRIMARY KEY (account_id, source_type)
);

-- Portal tables (mirror of migration 0007).
CREATE TABLE IF NOT EXISTS invite_codes (
  code_hash           text PRIMARY KEY,
  label               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  redeemed_at         timestamptz,
  redeemed_account_id text
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash  text PRIMARY KEY,
  email       text NOT NULL,
  account_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email);

CREATE TABLE IF NOT EXISTS portal_sessions (
  session_hash text PRIMARY KEY,
  account_id   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS portal_sessions_acct_idx ON portal_sessions (account_id);
