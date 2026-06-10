-- scripts/portal-dev-schema.sql
-- DEV ONLY — minimal schema to run the portal locally on a plain Postgres with
-- NO pgvector (the portal tables don't need it). This is NOT the production
-- migration path (that's scripts/migrations/, applied by `npm run migrate`).
-- It creates just the tables the portal touches so you can click through the
-- invite -> magic link -> sign-in -> credentials flow locally.

CREATE TABLE IF NOT EXISTS account (
  id                     text PRIMARY KEY,
  kind                   text,
  status                 text NOT NULL DEFAULT 'active',
  created_at             timestamptz NOT NULL DEFAULT now(),
  email                  text,
  plan                   text NOT NULL DEFAULT 'free',
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan_status            text,
  current_period_end     timestamptz,
  plan_comp              boolean NOT NULL DEFAULT false
);
-- Mirror of migration 0014 for dev DBs created before the column existed.
ALTER TABLE account ADD COLUMN IF NOT EXISTS plan_comp boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS account_email_uniq ON account (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_stripe_customer_uniq ON account (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id text PRIMARY KEY,
  type            text NOT NULL,
  account_id      text,
  received_at     timestamptz NOT NULL DEFAULT now()
);

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

-- Per-account MCP bearer tokens (mirror of migration 0006).
CREATE TABLE IF NOT EXISTS account_api_tokens (
  token_hash   text PRIMARY KEY,
  account_id   text NOT NULL,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_api_tokens_acct_idx ON account_api_tokens (account_id);

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

-- Passive usage metering (mirror of migration 0005) — read by the admin panel.
CREATE TABLE IF NOT EXISTS usage_log (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  metric      text NOT NULL,
  qty         bigint NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now()
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
  last_seen_at timestamptz,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS portal_sessions_acct_idx ON portal_sessions (account_id);
-- Mirror of migration 0015 for dev DBs created before user_agent existed.
ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS user_agent text;

-- AI search transparency log (mirror of migration 0015).
CREATE TABLE IF NOT EXISTS ai_search_log (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  query       text NOT NULL,
  results     int NOT NULL,
  client      text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_search_log_acct_ts_idx ON ai_search_log (account_id, ts DESC);

-- Leads / invite requests (mirror of migration 0008).
CREATE TABLE IF NOT EXISTS invite_requests (
  id               bigserial PRIMARY KEY,
  email            text NOT NULL,
  name             text,
  note             text,
  status           text NOT NULL DEFAULT 'pending',
  requested_at     timestamptz NOT NULL DEFAULT now(),
  invited_at       timestamptz,
  invite_code_hash text
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_email_uniq ON invite_requests (email);
CREATE INDEX IF NOT EXISTS invite_requests_status_idx ON invite_requests (status, requested_at DESC);

-- Entities + entity_mentions (mirror of migration 0011, for dev).
CREATE TABLE IF NOT EXISTS entities (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  type        text NOT NULL CHECK (type IN ('pessoa','empresa','projeto')),
  name        text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, type, name)
);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id           bigserial PRIMARY KEY,
  entity_id    bigint NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id     text NOT NULL,
  confidence   real CHECK (confidence BETWEEN 0 AND 1),
  extracted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, chunk_id)
);

-- Brain chunks (minimal mirror of 0001 + 0005, WITHOUT pgvector/tsv — plain
-- Postgres is enough for counts (/portal/status), week, next-meeting and
-- document listing in dev/e2e; search/embedding paths stay out of the dev server).
CREATE TABLE IF NOT EXISTS brain_chunks (
  id              text PRIMARY KEY,
  account_id      text NOT NULL DEFAULT 'bruno',
  source_type     text NOT NULL,
  source_id       text NOT NULL,
  workspace       text,
  db_name         text,
  parent_url      text,
  chunk_index     int NOT NULL DEFAULT 0,
  text            text NOT NULL,
  metadata        jsonb,
  indexed_at      timestamptz DEFAULT now(),
  source_updated  timestamptz
);
CREATE INDEX IF NOT EXISTS brain_chunks_source_idx ON brain_chunks (source_type, source_id);
CREATE INDEX IF NOT EXISTS brain_chunks_account_ws_idx ON brain_chunks (account_id, workspace, db_name);
-- Mirror of migration 0015: app-v2 card query indexes.
CREATE INDEX IF NOT EXISTS brain_chunks_acct_indexed_idx
  ON brain_chunks (account_id, indexed_at DESC);
CREATE INDEX IF NOT EXISTS brain_chunks_acct_calendar_data_idx
  ON brain_chunks (account_id, (left(metadata->>'data', 10)))
  WHERE source_type = 'calendar';
