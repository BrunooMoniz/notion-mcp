# Contract: Portal HTTP API (`/portal/*`)

New Express router mounted on the existing VPS server (`src/index.ts`). Distinct from the MCP transport and from `/notion/*`. All responses JSON unless noted. The static Cloudflare Pages front is the only intended client and calls these with `fetch(url, { credentials: 'include' })`.

**Auth model**: two tiers.
- **Public** (no session): `register`, `login`, `verify`. Rate-limited by email; responses are generic to avoid account enumeration.
- **Session-required**: everything under "Signed-in". Account scope is read from the `portal_sessions` row resolved from the cookie — **never** from request body/query (FR-011). Missing/expired session → `401`.

**Session cookie**: `portal_session=<opaque>`; `HttpOnly; Secure; SameSite=Lax`; `Domain=<parent registrable domain>`; sliding ~30-day expiry.

**CORS**: allow exact Pages origin, `Access-Control-Allow-Credentials: true`, methods `GET,POST,PUT,DELETE,OPTIONS`.

---

## Public endpoints

### POST /portal/register
Join by invite. Body: `{ "invite_code": string, "email": string }`.
- If `invite_code` is missing/invalid/already redeemed → `200` generic `{ "ok": true }` **without** creating an account or sending mail (no enumeration), and no invite consumed. (Account creation is refused server-side — FR-001/FR-002.)
- If valid + unused: resolve account by `email`; if none, create `account(kind='friend', email)` and atomically redeem the invite to it; if email already maps to an account, treat as sign-in and do **not** consume the invite (edge case). Issue a magic link, send email. → `200 { "ok": true }`.
- Always returns the same generic body regardless of branch.

### POST /portal/login
Sign in an existing friend (no invite). Body: `{ "email": string }`.
- If email maps to an account: issue magic link (superseding prior unconsumed), send email.
- If not: no-op. Either way → `200 { "ok": true }` (generic).

### GET /portal/verify?token=<plaintext>
Consume a magic link. 
- Valid (unconsumed, unexpired) → atomically mark consumed, create `portal_sessions` row, `Set-Cookie: portal_session=…`, `302` redirect to the Pages dashboard (`app.html`).
- Invalid/expired/reused → `302` redirect to the front page with an error flag; no session set (FR-004, SC-004).

---

## Signed-in endpoints (session required)

### POST /portal/logout
Delete the current session row, clear the cookie. → `204`.

### GET /portal/me
Account summary for the dashboard. → `200`:
```json
{
  "account_id": "friend:...",
  "email": "a@b.com",
  "mcp": { "configured": true },
  "sources": {
    "notion":   { "connected": true,  "workspaces": ["ws-id"], "last_run": "2026-06-05T...", "ok": true,  "error": null },
    "granola":  { "connected": true,  "last_run": "...", "ok": false, "error": "401 from Granola" },
    "ical":     { "count": 2, "last_run": "...", "ok": true, "error": null }
  }
}
```
Derived from vault presence + `status_runs` (FR-014). Never includes any secret value.

### GET /portal/sources
Masked credential inventory. Intentionally shares the same builder (and shape) as
`GET /portal/me`'s `sources` object — `ical` is `{ links: [...], count }`, and each
source carries its last run status: → `200`:
```json
{
  "notion":  { "connected": true },
  "granola": { "set": true, "masked": "••••abcd" },
  "ical":    { "links": [ { "id": "k3x9", "label": "Pessoal", "workspace": "personal", "masked_url": "https://…/…ab12.ics" } ], "count": 1 }
}
```

### Notion (reuses existing OAuth, R7)

#### GET /portal/notion/connect
Start/re-auth Notion for the **session's** account. Redirects to `/notion/connect` with the portal `account_id` carried in the signed OAuth `state`. The existing `/notion/callback` associates the resulting workspace + tokens to that account (no new identity-derived account). → `302`.
- Abandoned/denied mid-flow stores no partial credential; the friend can retry (edge case).

### iCal (multiple links; vault kind `ical` as JSON array — R5)

#### POST /portal/ical
Body: `{ "url": string, "label": string, "workspace"?: string }`. Appends an entry (assigns `id`), rewrites the encrypted array. → `201 { "id": "k3x9" }`. Stored encrypted; thereafter only masked (FR-008). Invalid/unreachable URL is still accepted and stored; the failure surfaces on the next index run (edge case).

#### PUT /portal/ical/:id
Body: partial `{ url?, label?, workspace? }`. Rewrites that entry. → `200`.

#### DELETE /portal/ical/:id
Removes the entry from the array. That source stops contributing to future indexing (edge case). → `204`.

### Granola (exactly one key; vault kind `granola`)

#### PUT /portal/granola
Body: `{ "key": string }`. Set or **rotate** the single Granola key (replaces prior). Next index run uses the new value (FR-009, SC-005). → `200`. Stored encrypted, shown masked.

#### DELETE /portal/granola
Removes the Granola key; source stops contributing. → `204`.

### Indexing trigger

#### POST /portal/reindex
Kick a per-account index run (`indexAccount(session.account_id)`) covering Notion + Granola + iCal (R4). Fire-and-forget; status is observed via `GET /portal/me`. → `202 { "started": true }`.

---

## Operator CLI (not an HTTP endpoint)

### `npm run make-invite -- [--label "for Alice"]`
`scripts/make-invite.mts`: generates a random code, stores its SHA-256 hash in `invite_codes`, prints the **plaintext once** to stdout. The operator delivers it out-of-band (FR-002, R6). No public generation route exists.

---

## Invariants enforced by this contract

- **FR-011 / SC-003**: every signed-in handler derives `account_id` from the resolved session, ignoring any account identifier in the request. No endpoint accepts a target account id.
- **FR-008 / SC-002**: no endpoint ever returns a stored secret in plaintext; writes go through the existing AES-256-GCM vault.
- **FR-004 / SC-004**: `verify` is single-use + time-bound; `register` is invite-gated; tokens stored as hashes.
- **Non-regression**: `/portal/*` is additive; existing `/notion/*`, MCP transport, `/health`, bearer/OAuth auth, and the operator's env/bearer path are untouched.
