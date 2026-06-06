# Tasks: Friend Account Portal (self-service onboarding)

**Input**: Design documents from `/specs/001-account-portal/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/portal-api.md, quickstart.md

**Tests**: INCLUDED — the spec's per-story Independent Tests and the project's "Definition of Done = machine-verified" rule require unit (`node:test`) + Playwright e2e. Tests are written before implementation within each story.

**Organization**: Tasks grouped by user story (US1 P1, US2 P2, US3 P2). The backend multi-tenant layer already exists and is reused unchanged; all tasks are additive.

## Path Conventions

Web app: backend in `src/` (existing Express server), static front in `portal/` (Cloudflare Pages), migrations in `scripts/migrations/`, e2e in `tests/e2e/`. Per plan.md structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffolding for the portal module, static front, and test harness.

- [ ] T001 Create the portal backend module skeleton (empty files with exports) `src/portal/{routes,invites,magic-link,session,email,sources}.ts` and the static front dir `portal/` per plan.md structure
- [ ] T002 [P] Add portal env vars to `.env.example` with comments: `RESEND_API_KEY`, `PORTAL_EMAIL_FROM`, `PORTAL_SESSION_COOKIE_DOMAIN`, `PORTAL_PAGES_ORIGIN` (CORS), reuse existing `SECRETS_KEY`/`BASE_URL`
- [ ] T003 [P] Add Playwright as a devDependency, create `playwright.config.ts` and `tests/e2e/` dir, add npm script `test:e2e` in `package.json`
- [ ] T004 [P] Wire `src/portal/__tests__/*.test.ts` into the existing `npm run test` glob and add npm script `make-invite` → `tsx scripts/make-invite.mts` in `package.json`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, session, and router wiring that every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T005 Create migration `scripts/migrations/0007_account_portal.sql`: `invite_codes`, `magic_links`, `portal_sessions` tables + additive `account.email text UNIQUE` column + indexes, per data-model.md
- [ ] T006 Verify migration: `npm run migrate -- --dry` lists 0007, then `npm run migrate` applies it cleanly against a dev DB
- [ ] T007 [P] Write failing unit test for the session module in `src/portal/__tests__/session.test.ts` (create→resolve returns account_id; expired row rejected; destroy revokes) using the `__setPoolForTest()` seam
- [ ] T008 Implement `src/portal/session.ts` (create/resolve/destroy; opaque 32-byte id; store only SHA-256 hash; sliding ~30-day expiry) to pass T007
- [ ] T009 Create the `/portal` router skeleton in `src/portal/routes.ts` with a `requireSession` middleware that resolves the cookie → account_id and returns 401 on miss (scope derived server-side, never from input — FR-011)
- [ ] T010 Mount the `/portal` router, add CORS for `PORTAL_PAGES_ORIGIN` with `Access-Control-Allow-Credentials: true`, and add cookie parsing in `src/index.ts` (additive; existing routes, MCP transport, and auth middleware untouched)

**Checkpoint**: Schema applied, sessions resolvable, `/portal` mounted — user stories can begin.

---

## Phase 3: User Story 1 — Join by invite + magic-link sign-in (Priority: P1) 🎯 MVP

**Goal**: A friend with a single-use invite code enters it + their email, gets an emailed magic link, clicks it, and lands in an authenticated portal session. No password. No valid invite → no account.

**Independent Test**: Invalid/absent code → registration blocked; valid code + email → emailed single-use link → verify → authenticated session; reused/expired link refused; reused invite refused.

### Tests for User Story 1 (write first, ensure they FAIL)

- [ ] T011 [P] [US1] Failing unit test for invites in `src/portal/__tests__/invites.test.ts` (atomic single redeem; second redeem of same code refused; unknown/used code refused)
- [ ] T012 [P] [US1] Failing unit test for magic links in `src/portal/__tests__/magic-link.test.ts` (single-use; expiry rejected; issuing a new link for an email invalidates prior unconsumed links)
- [ ] T013 [P] [US1] Failing Playwright e2e in `tests/e2e/us1-invite-magic-link.spec.ts`: invalid code blocked; valid code+email → captured link → verify → session cookie set; second verify of same link refused (email captured via `email.ts` test mode)

### Implementation for User Story 1

- [ ] T014 [P] [US1] Implement `src/portal/email.ts`: send magic-link email via Resend HTTP API using global `fetch`; in test mode (env flag) capture and return the link instead of sending (R1)
- [ ] T015 [P] [US1] Implement `src/portal/invites.ts`: issue (store SHA-256 hash) + redeem/validate (atomic `UPDATE … WHERE redeemed_at IS NULL`) to pass T011
- [ ] T016 [P] [US1] Implement `src/portal/magic-link.ts`: issue (hash at rest, ~15-min expiry, supersede prior unconsumed) + verify (single-use, atomic consume) to pass T012
- [ ] T017 [US1] Implement operator CLI `scripts/make-invite.mts`: generate a random code, store its hash via invites.ts, print the plaintext once (FR-002, R6)
- [ ] T018 [US1] Implement `POST /portal/register` in `src/portal/routes.ts`: invite-gated; resolve/create `account(kind='friend', email)`; if email already mapped, treat as sign-in (don't consume invite); issue + send magic link; generic `200` (no enumeration) (FR-001, FR-002)
- [ ] T019 [US1] Implement `POST /portal/login` in `src/portal/routes.ts`: email → issue + send magic link (supersede), generic `200` (FR-003)
- [ ] T020 [US1] Implement `GET /portal/verify` in `src/portal/routes.ts`: consume link, create session (T008), set `HttpOnly; Secure; SameSite=Lax` cookie on `PORTAL_SESSION_COOKIE_DOMAIN`, redirect to `app.html`; invalid/expired/reused → redirect with error (FR-004, FR-005)
- [ ] T021 [US1] Implement `POST /portal/logout` in `src/portal/routes.ts`: destroy session row, clear cookie
- [ ] T022 [P] [US1] Build static `portal/index.html`: invite code + email form posting to `/portal/register` (and login affordance) with `credentials:'include'`
- [ ] T023 [P] [US1] Build static `portal/check-email.html`: "sign-in link sent" confirmation
- [ ] T024 [P] [US1] Build static `portal/app.html` + `portal/app.js` + `portal/styles.css` shell: on load call `GET /portal/me` (credentials include); unauthenticated → bounce to index
- [ ] T025 [US1] Replace `landing()` in `src/notion-routes.ts` so `/onboard` (and `/`) serves/redirects to the portal front, replacing the current onboarding landing (FR-012)

**Checkpoint**: A friend can be admitted by invite and authenticated end-to-end. MVP demoable.

---

## Phase 4: User Story 2 — Self-manage source credentials (Priority: P2)

**Goal**: A signed-in friend connects/re-auths Notion (OAuth), adds/edits/removes multiple iCal links, and sets/rotates one Granola key. Everything stored encrypted via the existing vault; shown masked, never plaintext.

**Independent Test**: Signed in as account A — connect Notion, add 2 iCal links, set Granola key; reload → persist masked; inspect storage → ciphertext only; rotate Granola → next index uses new value.

### Tests for User Story 2 (write first, ensure they FAIL)

- [ ] T026 [P] [US2] Failing unit test in `src/portal/__tests__/sources.test.ts`: iCal JSON-array add/edit/delete + masked read; Granola set/rotate replaces the single value; reads never return plaintext (uses stub-pool + fake vault)
- [ ] T027 [P] [US2] Failing Playwright e2e in `tests/e2e/us2-credentials.spec.ts`: connect Notion (OAuth stub), add 2 iCal, set Granola → reload-persist masked → query `account_secrets` directly asserts ciphertext (`v1:` envelope, SC-002) → rotate Granola

### Implementation for User Story 2

- [ ] T028 [P] [US2] Implement `src/portal/sources.ts`: read masked inventory (notion connected/workspaces, granola set+masked, ical[] id/label/workspace/masked_url) and write iCal array + Granola via existing `setAccountSecret()`/`getAccountSecret()` (R5, FR-008)
- [ ] T029 [US2] Implement `GET /portal/sources` and `GET /portal/me` in `src/portal/routes.ts`: status derived from vault presence + `status_runs` for the session account (FR-014)
- [ ] T030 [US2] Implement iCal endpoints `POST /portal/ical`, `PUT /portal/ical/:id`, `DELETE /portal/ical/:id` in `src/portal/routes.ts` (append/edit/remove the encrypted array; accept-and-store even if unreachable — failure surfaces at index time)
- [ ] T031 [US2] Implement Granola endpoints `PUT /portal/granola` (set/rotate single key) and `DELETE /portal/granola` in `src/portal/routes.ts` (FR-007, FR-009)
- [ ] T032 [US2] Thread the portal `account_id` through Notion OAuth: add `GET /portal/notion/connect` (carries account_id in signed `state`) and modify `src/notion-oauth.ts` callback to associate the workspace + tokens to the existing portal account instead of minting a `notion:*` account; standalone operator flow unchanged (R7, FR-006)
- [ ] T033 [US2] Build the dashboard UI in `portal/app.html` + `portal/app.js`: Notion connect/re-auth button, iCal add/edit/remove list, Granola set/rotate/remove, all masked, with per-source status

**Checkpoint**: A friend manages all credentials self-service; secrets ciphertext-at-rest and masked.

---

## Phase 5: User Story 3 — Three sources index, isolated to my account (Priority: P2)

**Goal**: After connecting Notion, calendars, and Granola, the friend's content from all three indexes into their own brain, searchable only by them via their per-account MCP bearer. Zero cross-account leakage.

**Independent Test**: Accounts A and B each with own sources → index both → A searches sees only A, B only B; adversarial scope-widening returns zero foreign rows.

### Tests for User Story 3 (write first, ensure they FAIL)

- [ ] T034 [P] [US3] Failing Playwright e2e in `tests/e2e/us3-isolation.spec.ts`: two accounts index all three source types; cross-account `brain_search` (via each account's `acct_` bearer) returns 0 foreign docs; adversarial scope-widening attempt returns 0 (SC-003, FR-011)
- [ ] T035 [P] [US3] Failing unit/integration test in `src/rag/__tests__/index-account-sources.test.ts`: per-account Granola + iCal passes resolve from the vault and emit account-prefixed chunk IDs (isolation), via the stub-pool seam

### Implementation for User Story 3

- [ ] T036 [US3] Extend `src/rag/index-account.ts`: after the Notion pass, resolve the account's `granola` key and `ical[]` from the vault and run the existing Granola and iCal-ICS source passes inside the same per-account `requestContext` + `prefixChunkIds`, recording per-source runs (R4, FR-010) — reuses `src/rag/calendar-ics-source.ts` and the Granola source unchanged
- [ ] T037 [US3] Implement `POST /portal/reindex` in `src/portal/routes.ts`: fire-and-forget `indexAccount(session.account_id)` (covers all three sources), returns `202`
- [ ] T038 [US3] Surface per-source index status (last_run/ok/error from `status_runs`) in `GET /portal/me` and the dashboard so the friend sees connection + last index + errors (FR-014)

**Checkpoint**: All three sources index per account with proven isolation. Feature complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T039 [P] Non-regression: run full `npm run test` + operator `npm run eval`; confirm Bruno's index/search results unchanged (SC-006) and existing `/notion/connect` standalone, `/health`, bearer/OAuth auth tests stay green
- [ ] T040 [P] Add per-email rate limiting to `POST /portal/register` and `/portal/login` in `src/portal/routes.ts` (anti-enumeration / abuse on the public host)
- [ ] T041 [P] Run the full `quickstart.md` validation and tick every Definition-of-Done checkbox (migration, unit, e2e us1/us2/us3, at-rest probe, isolation, operator eval)
- [ ] T042 [P] Document the portal in `CLAUDE.md` (notion-mcp): new `/portal/*` routes, env vars, `npm run make-invite`, and the Pages+API shared-domain requirement

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. **Blocks all user stories.**
- **US1 (Phase 3)**: depends on Foundational. The MVP.
- **US2 (Phase 4)**: depends on Foundational; needs an authenticated session, so practically after US1's verify/session exist. Independently testable.
- **US3 (Phase 5)**: depends on Foundational; needs credentials present (US2) to be meaningful, but the indexer wiring (T036) is independently unit-testable.
- **Polish (Phase 6)**: after all targeted stories.

### User Story Dependencies

- **US1 (P1)**: standalone entry gate; no dependency on US2/US3.
- **US2 (P2)**: builds on the US1 session (sign-in must exist) but is its own testable slice.
- **US3 (P2)**: builds on US2 credentials for the e2e, but the per-account indexer change (T036) and its unit test (T035) can proceed in parallel once Foundational is done.

### Within Each User Story

- Tests written first and failing → implementation.
- Modules (invites/magic-link/email/session/sources) before the route handlers that compose them.
- Route handlers in the shared `src/portal/routes.ts` are sequential (same file), not parallel.
- Story complete before moving to the next priority.

### Parallel Opportunities

- Setup: T002, T003, T004 in parallel.
- Foundational: T007 (test) parallel to nothing blocking; T008→T009→T010 sequential (session impl → router → mount).
- US1 tests T011/T012/T013 in parallel; module impls T014/T015/T016 in parallel; static pages T022/T023/T024 in parallel. Route handlers T018–T021 sequential (same file).
- US2: T026/T027 (tests) parallel; T028 module before T029–T031 route handlers (sequential, same file); T032 (Notion files) parallel to T030/T031.
- US3: T034/T035 (tests) parallel; T036 (indexer) parallel to T037/T038 route work until they meet at the e2e.
- Polish T039–T042 all parallel.

---

## Parallel Example: User Story 1

```bash
# Tests first, together:
Task: "Unit test invites in src/portal/__tests__/invites.test.ts"
Task: "Unit test magic links in src/portal/__tests__/magic-link.test.ts"
Task: "Playwright e2e in tests/e2e/us1-invite-magic-link.spec.ts"

# Then module implementations together:
Task: "Implement src/portal/email.ts"
Task: "Implement src/portal/invites.ts"
Task: "Implement src/portal/magic-link.ts"

# Then static pages together:
Task: "Build portal/index.html"
Task: "Build portal/check-email.html"
Task: "Build portal/app.html + app.js + styles.css"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & VALIDATE** the invite + magic-link round trip (Playwright us1) → demoable: a friend can be admitted and signed in.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → test → demo (MVP: friend signs in).
3. US2 → test → demo (friend wires Notion/iCal/Granola, masked, encrypted).
4. US3 → test → demo (all three index, isolation proven).
5. Polish → non-regression + rate-limit + docs.

### Non-Regression Guardrails (throughout)

- Account scope always from the session/token, never request input (FR-011).
- No secret in repo; tokens hashed at rest; secrets only in the existing vault/env.
- Operator (Bruno) env/bearer path and existing routes untouched; `npm run test` never weakened to pass.

---

## Notes

- [P] = different files, no dependency. Handlers sharing `src/portal/routes.ts` are not [P] among themselves.
- [US#] maps each task to its story for traceability.
- Verify each test fails before implementing it.
- Commit after each task or logical group.
- Total: 42 tasks — Setup 4, Foundational 6, US1 15, US2 8, US3 5, Polish 4.
