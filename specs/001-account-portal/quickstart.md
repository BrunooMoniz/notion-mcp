# Quickstart & Validation: Friend Account Portal

How to run the feature locally and prove each user story passes by machine. Implementation details live in `data-model.md`, `contracts/portal-api.md`, and (after `/speckit-tasks`) `tasks.md`. This is a run/validation guide only.

## Prerequisites

- The existing backend running: `npm run migrate && npm run dev` (Postgres + pgvector reachable, `.env` configured as today).
- New env for this feature (secrets in `.env`, never committed):
  - `SECRETS_KEY` — already required by the vault.
  - `RESEND_API_KEY`, `PORTAL_EMAIL_FROM` — transactional email (R1). In test/e2e, the email module runs in capture mode and returns the link instead of sending.
  - `PORTAL_SESSION_COOKIE_DOMAIN` — parent registrable domain shared by the Pages front and the API (R3).
  - `PORTAL_BASE_URL` / Pages origin allowed by CORS.
- Apply this feature's migration: `npm run migrate` (runs `0007_account_portal.sql`).
- Frontend: serve `portal/` statically (locally any static server; prod = Cloudflare Pages).

## Validation by user story

### US1 — Join by invite + magic-link sign-in (P1)

1. Create an invite: `npm run make-invite -- --label "QA"` → copy the printed code (shown once).
2. **Negative**: `POST /portal/register` with no/invalid code → confirm no account row created and no email captured.
3. **Positive**: `POST /portal/register { invite_code, email }` → capture the emailed link, `GET /portal/verify?token=…` → confirm `Set-Cookie: portal_session` and redirect to `app.html`.
4. **Single-use**: re-`GET` the same verify URL → refused, no new session. Expire a link (clock/short TTL) → refused (FR-004).
5. **Invite reuse**: register again with the same code → refused (FR-002).

- **Unit** (`npm run test`): magic-link single-use/expiry/supersede; invite atomic single-redeem.
- **E2E** (`npx playwright test us1`): full browser round trip via the email capture sink.
- **Proves**: FR-001..FR-005, SC-004.

### US2 — Self-manage source credentials (P2)

1. Signed in as account A: `GET /portal/notion/connect` → complete Notion OAuth → confirm workspace linked to A (not a new `notion:*` account) (R7).
2. `POST /portal/ical` twice; `PUT /portal/granola { key }`.
3. Reload `GET /portal/sources` → entries persist, shown **masked** (never plaintext).
4. **Ciphertext at rest**: query `account_secrets` for A directly → values are AES-GCM envelopes (`v1:…`), no plaintext (SC-002).
5. **Rotation**: `PUT /portal/granola` with a new key → `POST /portal/reindex` → confirm the run used the new value (FR-009, SC-005).

- **Unit**: iCal array add/edit/delete + masking; Granola rotate replaces single value.
- **E2E** (`us2`): connect → reload-persist → at-rest probe → rotate.
- **Proves**: FR-006..FR-009, FR-014, SC-002, SC-005.

### US3 — Three sources index, isolated per account (P2)

1. Set up accounts A and B, each with their own Notion/Granola/iCal.
2. `POST /portal/reindex` for both → confirm A's brain has docs from all three source types (FR-010, R4).
3. **Isolation**: query as A (A's `acct_` MCP bearer) → only A's docs; as B → only B's (SC-003).
4. **Adversarial**: attempt to widen scope to the other account (manipulated request) → zero foreign rows; scope comes from the session/token, not input (FR-011).

- **E2E** (`us3`): two-account index + cross-account search returns 0 foreign docs, including scope-widening attempt.
- **Proves**: FR-010, FR-011, SC-003.

## Non-regression checks (must stay green)

- Operator (`bruno`) indexes and searches identically before/after (SC-006): run the existing `npm run eval` / hourly indexer path → unchanged results.
- Existing `/notion/connect`, `/notion/callback` standalone flow, `/health`, MCP bearer + OAuth auth, and the Notion destructive-confirm rule all still pass their existing tests.
- `npm run test` (full suite) green; no test weakened or skipped.

## Definition of done (machine-verifiable)

- [ ] `npm run migrate` applies `0007` cleanly (and `--dry` lists it before).
- [ ] `npm run test` green (unit/integration incl. new portal tests).
- [ ] `npx playwright test` green for us1/us2/us3.
- [ ] At-rest probe shows zero plaintext secrets (SC-002).
- [ ] Two-account isolation test shows zero cross-account leakage (SC-003).
- [ ] Operator eval unchanged (SC-006).
