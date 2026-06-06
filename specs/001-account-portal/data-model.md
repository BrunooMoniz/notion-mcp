# Phase 1 Data Model: Friend Account Portal

All new persistence is one additive migration: `scripts/migrations/0007_account_portal.sql`. Secrets remain in the existing `account_secrets` vault (no new secret table). Tokens (invite, magic-link, session) follow the established **hash-at-rest** pattern from `account_api_tokens` — only the SHA-256 hash is stored; the plaintext is shown once and never persisted.

## Reused (unchanged) entities

| Entity | Where | Role in this feature |
|---|---|---|
| `account` (id, kind, status, created_at) | `0005_accounts_and_usage.sql` | The tenant. Friends get a row with `kind='friend'`. **Additive change**: new nullable `email` column (below). |
| `account_workspaces` (account_id, workspace) | `0005` | Notion connect adds the friend's workspace here. |
| `account_secrets` (account_id, kind, enc_value) | `0005`, `secrets.ts` | Vault. Holds `notion_*`, `granola`, and `ical` (JSON array) per account. AES-256-GCM. |
| `account_api_tokens` (token_hash, account_id, …) | `0006`, `account-bearer.ts` | The MCP `acct_` bearer issued for the friend's AI client. Unchanged. |
| `usage_log` (account_id, metric, qty, ts) | `0005`, `usage.ts` | Passive metering; no change, no enforcement (FR-013). |
| `status_runs` / sync state | `0005`, `storage.ts:recordRun` | Source-by-source run outcomes; read by the portal's status view (FR-014). |

## New / modified entities

### account.email (additive column)

```
ALTER TABLE account ADD COLUMN email text UNIQUE;
```

- One email maps to **exactly one** account (UNIQUE). Friends created via invite get their email here.
- Existing `'bruno'` owner row keeps `email = NULL` (operator uses bearer/env, not the portal) — no behavior change.
- Resolves the spec edge case "invite valid but email already associated → sign-in, not duplicate": registration looks up by email first.

### invite_codes

| Field | Type | Notes |
|---|---|---|
| `code_hash` | `text PRIMARY KEY` | SHA-256 of the plaintext code. Plaintext shown once by the CLI, never stored. |
| `label` | `text NULL` | Operator note (who it's for). |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `redeemed_at` | `timestamptz NULL` | Set atomically on redemption. NULL = unused. |
| `redeemed_account_id` | `text NULL REFERENCES account(id)` | The account created/associated by this code. |

- **Single-use**: redemption is `UPDATE … SET redeemed_at=now(), redeemed_account_id=$acct WHERE code_hash=$h AND redeemed_at IS NULL` — succeeds for exactly one caller (FR-001, FR-002, SC-004).
- Validation rule: account creation refused unless a row exists with matching hash and `redeemed_at IS NULL`.

### magic_links

| Field | Type | Notes |
|---|---|---|
| `token_hash` | `text PRIMARY KEY` | SHA-256 of the single-use sign-in token (carried in the link URL). |
| `email` | `text NOT NULL` | Target email. |
| `account_id` | `text NULL REFERENCES account(id)` | Resolved account (known at issue time). |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `expires_at` | `timestamptz NOT NULL` | ~15 min after creation (FR-004). |
| `consumed_at` | `timestamptz NULL` | Set on first successful verify. |

- **Single-use + expiry**: verify succeeds only when `consumed_at IS NULL AND expires_at > now()`, then atomically sets `consumed_at` (FR-004, SC-004).
- **Supersede on reissue**: issuing a new link for an email invalidates prior unconsumed links — `DELETE FROM magic_links WHERE email=$e AND consumed_at IS NULL` before inserting the new one (spec edge case; FR-004).
- Index: `(email)` for the supersede sweep; `(expires_at)` for cleanup.

### portal_sessions

| Field | Type | Notes |
|---|---|---|
| `session_hash` | `text PRIMARY KEY` | SHA-256 of the opaque cookie value (32 random bytes). |
| `account_id` | `text NOT NULL REFERENCES account(id)` | Scope source of truth for `/portal/*` (FR-011). |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `expires_at` | `timestamptz NOT NULL` | Sliding ~30 days; refreshed on activity. |
| `last_seen_at` | `timestamptz NULL` | Updated on resolve (sliding window). |

- Resolve: hash cookie → row where `expires_at > now()` → `account_id`. Logout / revoke: `DELETE`.
- Index: `(account_id)` for "revoke all sessions for account".

### Credential (vault secret) — shape conventions (no schema change)

Stored in existing `account_secrets (account_id, kind, enc_value)`:

| kind | Plaintext shape (encrypted at rest) | Cardinality |
|---|---|---|
| `notion_access:<ws>` / `notion_refresh:<ws>` / `notion_pat:<ws>` | token string | per workspace (existing) |
| `granola` | API key string | exactly one per account |
| `ical` | JSON: `[{ "id": "<shortid>", "url": "<secret ics url>", "label": "...", "workspace": "..." }]` | many links in one blob (R5) |

- **Masking on read (FR-008, SC-002)**: the portal never returns a stored secret in plaintext. iCal returns `id/label/workspace` + masked URL tail; Granola returns presence + masked tail; Notion returns connected/workspace only. Ciphertext-at-rest is the existing vault guarantee.

### Source / index status (read model, FR-014)

No new table. The portal's status view is **derived** per account from:
- presence of vault kinds (`notion_*`, `granola`, `ical`) → "connected" flags,
- `status_runs` filtered by `account_id` → last run time + ok/error per source,
- `account_workspaces` → which Notion workspaces are linked.

## Entity relationships

```
account (1) ──< (N) account_workspaces
account (1) ──< (N) account_secrets        # notion_*, granola, ical[]
account (1) ──< (N) account_api_tokens     # acct_ MCP bearer
account (1) ──< (N) portal_sessions
account (1) ──< (N) magic_links
account (1) ──0..1 invite_codes            # the code that created it (redeemed_account_id)
account (1) ──< (N) usage_log / status_runs
account.email ── UNIQUE ── one email ↔ one account
```

## Lifecycle / state transitions

**Invite code**: `created (redeemed_at NULL)` → `redeemed (redeemed_at set, bound to account)`. Terminal; cannot create a second account.

**Magic link**: `issued (consumed_at NULL, unexpired)` → `consumed (single-use)` | `expired (expires_at passed)`. Reissue for same email deletes prior `issued` links.

**Portal session**: `active (unexpired)` → `expired` (time) | `revoked` (logout/operator delete). Sliding refresh on resolve.

**Account onboarding (happy path)**: invite redeemed → account row (`kind='friend'`, email set) → magic-link issued → verified → session active → Notion OAuth associated (state-carried account_id) → iCal links + Granola key written to vault → `acct_` MCP bearer issued (existing) → per-account index runs Notion + Granola + iCal (R4).
