# Phase 0 Research: Friend Account Portal

Resolves the unknowns in the plan's Technical Context. Each item: Decision / Rationale / Alternatives considered. Grounded in an audit of the existing `notion-mcp` backend.

## R1 — Transactional email for magic links (NEW capability)

**Finding**: No email capability exists anywhere in the repo (no nodemailer/resend/smtp/sendgrid; zero matches). Magic links require sending one email per sign-in request.

**Decision**: Send magic-link emails through a **transactional HTTP API (Resend)** called with the Node global `fetch` — **no new npm dependency**. A single `src/portal/email.ts` posts to the provider with an API key from env (`RESEND_API_KEY`, `PORTAL_EMAIL_FROM`). The provider and API key are operator-configured out-of-band; the from-address requires a verified sending domain.

**Rationale**: Matches the repo's established zero-dependency, `fetch`-based integration pattern (`web-source.ts`, Granola client). Avoids running/securing an SMTP server on the single VPS and avoids credential sprawl. Keeps the change surgical: one small module behind an interface, mockable in tests. **Flagged per CLAUDE.md**: this is a new outbound integration requiring operator setup (Resend account + verified domain + API key). Email is non-secret transport but the API key is a secret → env only, never repo.

**Alternatives considered**:
- **nodemailer + SMTP** — adds an npm dependency and requires SMTP credentials/host management on the VPS; more moving parts for the same outcome. Rejected.
- **Amazon SES SDK** — heavier dependency and AWS account coupling; overkill for tens of accounts. Rejected.
- **Postmark / SendGrid via fetch** — equivalent to Resend; Resend chosen for the simplest API and generous low-volume free tier. Any of these is a drop-in behind `email.ts` if the operator prefers.

**Failure handling (FR/edge)**: email send failure must surface to the requester as a generic retryable state and must NOT create a usable session; the magic link is already persisted (single-use, expiring) so a resend re-issues a fresh link and invalidates the prior one.

## R2 — Portal session mechanism (distinct from MCP `acct_` bearer)

**Finding**: The existing `acct_` bearer (`account-bearer.ts`) authenticates **MCP** queries (SHA-256 hash at rest, 60s cache). It is the wrong primitive for a browser session (no cookie, shown-once, MCP-scoped).

**Decision**: **Server-side session with an opaque cookie.** On magic-link verify, generate a random 32-byte session id, store only its **SHA-256 hash** in a new `portal_sessions` table with `account_id` + `expires_at`, and set an **`HttpOnly; Secure; SameSite=Lax`** cookie carrying the plaintext id. Resolve per request by hashing the cookie and looking up the row; sliding expiry (~30 days). Logout deletes the row.

**Rationale**: Reuses the exact hash-at-rest discipline already proven in `account-bearer.ts` (token never stored in plaintext, safe to log). Server-side rows give instant revocation (logout, operator kill) which a stateless JWT cannot. `HttpOnly` keeps it out of JS (XSS-resistant), unlike a localStorage token. Account scope is read from the session row server-side, satisfying FR-011 (scope never from client input).

**Alternatives considered**:
- **Stateless signed JWT cookie** — no DB lookup, but no revocation and a signing-key rotation burden; rejected for a security-sensitive shared host.
- **localStorage bearer + Authorization header** — avoids cookies entirely but exposes the token to any XSS and complicates logout; rejected.

## R3 — Cross-origin between Cloudflare Pages front and VPS API

**Finding**: Cloudflare Pages (locked) serves the static front from a different host than the VPS API. Browsers are phasing out third-party cookies, so a cookie set by the API on an unrelated Pages origin would be unreliable.

**Decision**: **Deploy the portal and the API under the same registrable domain** — e.g. `portal.<domain>` (Pages) and `api.<domain>` (VPS). The session cookie is set on the parent domain so it is **same-site** for the SPA's `fetch(..., { credentials: 'include' })` calls; `SameSite=Lax` then works without third-party-cookie exposure. The API enables **CORS** for the exact Pages origin with `Access-Control-Allow-Credentials: true`.

**Rationale**: "Same site" = same registrable domain, so cross-subdomain XHR with credentials is first-party and future-proof against third-party-cookie removal. Avoids token-in-JS. Minimal backend change (CORS middleware for one allowed origin + cookie domain attribute).

**Alternatives considered**:
- **Unrelated Pages domain + `SameSite=None`** — works today but rides on third-party cookies being phased out; fragile. Rejected.
- **Serve the SPA from the VPS itself (same origin)** — simplest cross-origin story, but contradicts the locked Cloudflare Pages decision. Rejected (revisit only if the operator drops the Pages lock).

**Operator dependency (flagged)**: requires a domain with both a Pages subdomain and the API subdomain (TLS on the API, already implied by `Secure` cookies / `BASE_URL`).

## R4 — Per-account indexing of Granola + iCal (gap in existing backend)

**Finding (important)**: `src/rag/index-account.ts` indexes **only Notion** for onboarded accounts. Granola and calendar passes exist only in the **operator/global** indexer (`src/rag/indexer.ts`, env-driven `GRANOLA_*` tokens and `GOOGLE_CAL_ICS`). The vault already defines `granola` and `ical` secret kinds, but the per-account pass does not yet consume them.

**Decision**: Treat **wiring Granola + iCal into the per-account indexer as in-scope additive plumbing** for this feature (FR-010 requires all three sources to index into the friend's account). Extend `indexAccount()` to, after the Notion pass, resolve the account's `granola` key and `ical` link list from the vault and run the existing Granola and iCal-ICS source passes through the same per-account `requestContext` + `prefixChunkIds` isolation already used for Notion. Reuse `src/rag/calendar-ics-source.ts` and the Granola source as-is; only the per-account orchestration is new.

**Rationale**: This is additive (new branches in one function), not a rebuild — the source passes and isolation primitives already exist and stay unchanged, preserving the non-regression constraint. Without it, a friend could store Granola/iCal credentials in the portal but they would never index, breaking US3/FR-010.

**Alternatives considered**:
- **Declare Granola/iCal per-account indexing already-done and out of scope** — contradicted by the code; would ship a portal that silently drops two of three sources. Rejected.
- **A separate per-account granola/ical worker** — more processes and duplicated orchestration; rejected in favor of extending the one `indexAccount()` entry point.

## R5 — iCal storage shape (multiple links, one Granola key)

**Finding**: Vault PK is `(account_id, kind)` → one value per kind. Spec allows **multiple** iCal links but exactly **one** Granola key per account. Operator's iCal config is a JSON array (`GOOGLE_CAL_ICS = [{url,label,workspace}]`).

**Decision**: Store the account's iCal links as a **single JSON-array blob** under vault kind `ical` (`[{ id, url, label, workspace }]`), mirroring the operator's `GOOGLE_CAL_ICS` shape; add/edit/remove rewrite the whole array. Store the Granola key as a plain string under kind `granola`. Each iCal entry gets a stable `id` (random short id) so the portal can address a single link for edit/delete without exposing the secret URL.

**Rationale**: No schema change to the vault (reuses `(account_id, kind)`), reuses the exact JSON shape the iCal source already parses, and keeps "one Granola key" naturally enforced by the single-value-per-kind PK. Masking on read returns only `id/label/workspace` + a masked URL tail.

**Alternatives considered**:
- **A new relational `account_sources` table** — more normalized but adds a migration and a second source of truth alongside the vault; rejected as over-engineering for tens of accounts.

## R6 — Invite code generation & redemption

**Finding**: Spec says invite codes are operator-generated out-of-band, single-use, one code = one account. No admin UI is in scope.

**Decision**: An **operator CLI** `scripts/make-invite.mts` generates a random code, stores its **SHA-256 hash** in `invite_codes` (with optional label), and prints the plaintext **once**. Redemption (`POST /portal/register`) hashes the submitted code, requires an unredeemed match, and atomically marks it redeemed bound to the new account. Codes are never stored or returned in plaintext after creation.

**Rationale**: Mirrors the bearer/magic-link hash-at-rest pattern; no public generation endpoint means no privilege-escalation surface. CLI fits the operator's existing `npm run`-script workflow (`migrate`, `reindex`, etc.).

**Alternatives considered**:
- **Admin HTTP endpoint** — needs its own auth and widens the attack surface on a public-internet host; rejected for an out-of-band, low-frequency operator action.

## R7 — Notion OAuth association to an existing portal account

**Finding**: `/notion/connect` + `/notion/callback` (`notion-routes.ts`, `notion-oauth.ts`) currently mint an account id **from the Notion identity** (`accountIdForWorkspace` → `notion:workspace-id`) and issue a fresh `acct_` bearer at the end. A portal friend already has an account (created at invite redemption) and a session; their Notion must attach to **that** account, not spawn a parallel `notion:*` account.

**Decision**: Thread the **portal `account_id` through the OAuth `state`**. When the portal initiates Notion connect for a signed-in friend, the callback detects the carried account id and associates the Notion workspace + encrypted tokens to the **existing** account (`account_workspaces` + vault) instead of creating a new identity-derived account. The standalone operator flow (no carried account) is unchanged. Re-authenticate is the same flow re-run.

**Rationale**: Additive branch keyed on state; preserves the existing standalone path (non-regression) while making Notion connect coherent with portal accounts. State already exists for CSRF, so it is the natural carrier (signed/opaque, server-validated).

**Alternatives considered**:
- **Merge accounts post-hoc** (let Notion mint `notion:*`, then reconcile to the friend account) — fragile data migration and a window of split identity; rejected.

## R8 — Testing strategy for the spec's Independent Tests

**Finding**: Existing tests are Node-native `node:test` with a `__setPoolForTest()` stub-pool seam; **no Playwright/e2e harness exists**. The spec's Independent Tests are explicitly end-to-end (drive the flow, read the emailed link, assert isolation).

**Decision**: Two layers. **(a) Unit/integration** via `node:test` for invite redemption (single-use, atomic), magic-link tokens (single-use, expiry, supersede-on-reissue), session resolve/expire, vault iCal-array read/write masking — using the stub-pool seam, no live DB. **(b) Playwright e2e** for US1 (invite-gate + magic-link round trip via a test email sink/inbox capture), US2 (connect sources, reload-persist, ciphertext-at-rest probe), US3 (two-account isolation incl. adversarial scope-widening). Email in e2e is captured via a test transport (the `email.ts` interface returns the link in test mode) rather than a real provider.

**Rationale**: Honors the project's "Definition of Done = machine-verified" rule and the spec's per-story Independent Tests; keeps fast logic tests where the existing seam already works and reserves Playwright for the genuinely cross-process flows.

**Alternatives considered**:
- **e2e-only** — slow and poor at asserting token edge cases (expiry/reuse); rejected.
- **Mock the whole flow in unit tests** — cannot prove the browser→API→email round trip US1 requires; rejected.

## Resolved unknowns summary

| Unknown (Technical Context) | Resolution |
|---|---|
| Email transport (none existed) | Resend via global `fetch`, no npm dep; env API key; operator domain verification (R1) |
| Portal session vs MCP bearer | Server-side `portal_sessions`, opaque HttpOnly cookie, hash at rest (R2) |
| Pages↔VPS cross-origin / cookies | Shared registrable domain, SameSite=Lax, CORS w/ credentials (R3) |
| Granola/iCal per-account indexing | In-scope additive wiring in `indexAccount()` (R4) |
| iCal multi-link storage | JSON-array blob under existing vault kind `ical` (R5) |
| Invite generation | Operator CLI `make-invite.mts`, hash at rest (R6) |
| Notion OAuth → existing account | Carry portal account_id in OAuth state (R7) |
| Test strategy | node:test unit + new Playwright e2e (R8) |
