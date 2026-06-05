-- scripts/migrations/0006_account_api_tokens.sql
-- Applied by the migration runner: npm run migrate
--
-- F3.2c — per-account MCP bearer tokens. Each onboarded account gets a personal
-- bearer it puts in Claude to query ONLY its own brain. We store the SHA-256 of
-- the token (a hash, safe in plaintext — not the token itself); the bearer is
-- shown to the user once at onboarding. The /mcp auth middleware resolves a
-- presented token by hash → account_id, then scopes brain_search to that account.
-- Additive + idempotent; nothing existing is touched ('bruno' keeps BEARER_TOKEN).

CREATE TABLE IF NOT EXISTS account_api_tokens (
  token_hash  text PRIMARY KEY,         -- sha256(token) hex
  account_id  text NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_api_tokens_acct_idx ON account_api_tokens (account_id);
