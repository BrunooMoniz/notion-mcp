-- scripts/migrations/0005_accounts_and_usage.sql
-- Applied by the migration runner: npm run migrate
--
-- F3.0 — multi-tenant FOUNDATION (additive, idempotent, behavior-preserving).
-- Introduces an `account_id` dimension defaulting to 'bruno' so the system stays
-- single-account today (current behavior unchanged), while every row gains the
-- column the freemium/multi-tenant work (Fase 3) will scope by. Also adds the
-- account/secrets/usage tables (mostly unused until F3.1+) and a passive
-- usage_log for metering. embedding_cache is deliberately left global (tenant-
-- scoping it is a later privacy decision, not invariant).

-- account_id on the data tables (default 'bruno' = the one current account).
ALTER TABLE brain_chunks ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'bruno';
ALTER TABLE brain_facts  ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'bruno';
ALTER TABLE status_runs  ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'bruno';

-- sync_state: add account_id and make the key (account_id, source_type) so each
-- account tracks its own sync cursors. Idempotent: only swap the PK once.
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'bruno';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sync_state'::regclass AND contype = 'p' AND conname = 'sync_state_pkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sync_state'::regclass AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (account_id, source_type)'
  ) THEN
    ALTER TABLE sync_state DROP CONSTRAINT sync_state_pkey;
    ALTER TABLE sync_state ADD PRIMARY KEY (account_id, source_type);
  END IF;
END $$;

-- Composite indexes so account-scoped reads stay index-served.
CREATE INDEX IF NOT EXISTS brain_chunks_account_ws_idx ON brain_chunks (account_id, workspace, db_name);
CREATE INDEX IF NOT EXISTS status_runs_account_idx ON status_runs (account_id, worker, source);
CREATE INDEX IF NOT EXISTS brain_facts_account_idx ON brain_facts (account_id);

-- Account model tables (created now; populated in F3.1+ when secrets/workspaces
-- move out of .env). Seed the current single account.
CREATE TABLE IF NOT EXISTS account (
  id          text PRIMARY KEY,
  kind        text,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO account (id, kind, status) VALUES ('bruno', 'owner', 'active')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS account_workspaces (
  account_id  text NOT NULL,
  workspace   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace)
);
INSERT INTO account_workspaces (account_id, workspace) VALUES
  ('bruno', 'personal'), ('bruno', 'globalcripto'), ('bruno', 'nora')
  ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS account_secrets (
  account_id  text NOT NULL,
  kind        text NOT NULL,        -- e.g. 'notion_pat:personal', 'granola:personal'
  enc_value   text NOT NULL,        -- AES-256-GCM ciphertext (F3.1)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind)
);

-- Passive usage metering (F3.0): append-only, never enforced yet (free-tier
-- limits land in F3.3). One row per metered event.
CREATE TABLE IF NOT EXISTS usage_log (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  metric      text NOT NULL,        -- 'search' | 'embed_tokens' | 'chunks'
  qty         bigint NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_log_acct_metric_idx ON usage_log (account_id, metric, ts);
