-- scripts/migrations/0007_account_portal.sql
-- Applied by the migration runner: npm run migrate
--
-- 001-account-portal — the friend-facing self-service portal. Adds the three
-- token tables the portal owns (all hash-at-rest, mirroring account_api_tokens)
-- plus an email column on `account` so a friend's sign-in email maps to exactly
-- one account. Additive + idempotent; nothing existing is touched (the 'bruno'
-- owner row keeps email NULL and never uses the portal).

-- One email <-> one account. NULL allowed (the operator 'bruno' has none).
ALTER TABLE account ADD COLUMN IF NOT EXISTS email text;
CREATE UNIQUE INDEX IF NOT EXISTS account_email_uniq ON account (email) WHERE email IS NOT NULL;

-- Operator-generated, single-use invite codes. Only the SHA-256 hash is stored;
-- the plaintext is printed once by `npm run make-invite` and delivered out-of-band.
CREATE TABLE IF NOT EXISTS invite_codes (
  code_hash           text PRIMARY KEY,        -- sha256(code) hex
  label               text,                    -- operator note (who it's for)
  created_at          timestamptz NOT NULL DEFAULT now(),
  redeemed_at         timestamptz,             -- NULL = unused
  redeemed_account_id text                     -- the account this code created/associated
);

-- Single-use, short-lived magic sign-in links. Hash at rest; the plaintext token
-- travels only in the emailed URL. Reissuing for an email invalidates prior
-- unconsumed links (handled in code by deleting them before insert).
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash  text PRIMARY KEY,                -- sha256(token) hex
  email       text NOT NULL,
  account_id  text,                            -- resolved account at issue time
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz                      -- set on first successful verify
);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email);
CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links (expires_at);

-- Server-side portal sessions. The opaque cookie carries the plaintext id; only
-- its SHA-256 hash is stored, so a leaked DB row can't be replayed as a cookie.
CREATE TABLE IF NOT EXISTS portal_sessions (
  session_hash text PRIMARY KEY,               -- sha256(cookie value) hex
  account_id   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS portal_sessions_acct_idx ON portal_sessions (account_id);
