# Feature Specification: Friend Account Portal (self-service onboarding)

**Feature Branch**: `001-account-portal`

**Created**: 2026-06-05

**Status**: Draft

**Input**: User description: "Portal do amigo (self-service) para o segundo cérebro multi-tenant. Login por e-mail + magic link, registro por código de convite, gestão self-service de credenciais (Notion OAuth, links iCal, chave Granola), garantindo que as 3 fontes indexem isoladas por conta. O portal SUBSTITUI a landing de onboarding atual. Backend multi-tenant (account_id, vault cifrado, onboarding Notion/PAT, indexação por conta, MCP bearer por conta, metering passivo) JÁ EXISTE e não deve ser reespecificado nem regredido."

## Context (existing backend — dependency, not in scope to rebuild)

The `notion-mcp` server already ships, in `main`, the full multi-tenant backend this portal sits on top of: an `account` dimension across all data, a passive usage meter, a per-account encrypted secret vault (kinds `notion_pat`, `granola`, `ical`), a Notion public-OAuth and PAT onboarding path, per-account isolated indexing, and a per-account MCP bearer so an onboarded person queries only their own brain. This feature adds the **friend-facing portal** that lets a non-technical person self-serve all of that, and **replaces the current minimal onboarding landing**. The backend pieces above are invariants: they must keep working unchanged (see Non-Regression Constraints).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Join by invite and sign in with a magic link (Priority: P1)

A friend receives a one-time invite code from the operator. They open the portal, enter the code and their email, receive a single-use sign-in link by email, click it, and land logged in to their own account. No password is ever set or asked for. People without a valid invite code cannot create an account.

**Why this priority**: It is the entry gate. Nothing else in the portal is reachable until a person can get in, and gating by invite is what keeps the single shared VPS from being opened to the public. It is a viable standalone slice: a friend can be admitted and authenticated even before any credential management exists.

**Independent Test**: Drive the flow end-to-end (Playwright): submit an invalid/absent code and confirm registration is blocked; submit a valid code + email, retrieve the emailed link, follow it, and confirm an authenticated session. Unit-test the magic-link token: single-use, short expiry, not reusable after consumption or expiry.

**Acceptance Scenarios**:

1. **Given** a person with no invite code, **When** they attempt to register, **Then** account creation is refused and no account is created.
2. **Given** a valid, unused invite code and an email, **When** they request access, **Then** a single-use sign-in link is sent to that email and an account is provisioned/associated.
3. **Given** a valid magic link, **When** it is clicked the first time, **Then** the person is signed in; **When** the same link is clicked again or after it expires, **Then** sign-in is refused.
4. **Given** an already-used invite code, **When** someone tries to reuse it, **Then** registration is refused.

---

### User Story 2 - Self-manage source credentials (Priority: P2)

Once signed in, the friend manages their own data sources from a single page: connect or re-authenticate Notion (public OAuth), add/edit/remove their secret iCal calendar links, and add/rotate their Granola API key. They can change any of these later without operator help. Every secret is stored encrypted; the friend never sees another person's secrets and the system never displays a stored secret back in plaintext.

**Why this priority**: This is the core value — a non-technical person wiring up their own second brain without `.env`, psql, or operator involvement. It depends on US1 (must be signed in) but is independently testable and demonstrable once login exists.

**Independent Test**: Signed in as account A (Playwright): connect Notion via OAuth, add two iCal links, set a Granola key; reload and confirm they persist as managed entries (masked, never plaintext). Inspect storage directly to confirm ciphertext at rest. Rotate the Granola key and confirm the next indexing run uses the new value.

**Acceptance Scenarios**:

1. **Given** a signed-in friend, **When** they complete the Notion OAuth connect flow, **Then** their Notion is linked to their account and indexing can use it.
2. **Given** a signed-in friend, **When** they add or edit an iCal secret link or a Granola API key, **Then** the value is persisted encrypted and shown only in masked form thereafter.
3. **Given** a stored credential, **When** the friend rotates or replaces it, **Then** the old value is superseded and the next indexing run uses the new value.
4. **Given** any stored credential, **When** storage is inspected at rest, **Then** no secret appears in plaintext.

---

### User Story 3 - My three sources index, isolated to my account (Priority: P2)

After connecting Notion, calendars, and Granola, the friend's content from all three sources is indexed into their own brain and is searchable only by them (through their MCP connection in their preferred AI client). One account can never see another account's data, and vice versa.

**Why this priority**: It is the payoff of onboarding and the security invariant that makes the shared-VPS model acceptable. It depends on US2 (credentials present) but is independently verifiable via search results and isolation probes.

**Independent Test**: With account A and account B each having their own Notion/Granola/iCal sources, run the per-account index for both; query as A and confirm only A's content returns (and B only B's). Adversarial isolation test: attempts to widen scope to another account return zero foreign rows.

**Acceptance Scenarios**:

1. **Given** a friend who has connected all three source types, **When** their indexing runs, **Then** documents from Notion, Granola, and iCal calendars all appear in their brain.
2. **Given** two accounts with distinct data, **When** account A searches, **Then** results contain only account A's documents and never account B's.
3. **Given** a request that tries to reference another account, **When** it is processed, **Then** the account scope is taken from the authenticated session, not the request input, and no foreign data is returned.

---

### Edge Cases

- Magic link requested for an email mid-flow or already signed in: a new link supersedes prior unconsumed links; only the latest unexpired link works.
- Invite code valid but email already associated with an account: treated as a sign-in, not a duplicate account.
- Notion OAuth connect abandoned or denied midway: no partial credential is stored; the friend can retry.
- Invalid or unreachable iCal link / wrong Granola key entered: the credential is accepted and stored, but the next indexing run for that source reports a failure surfaced to the friend, without breaking the other sources.
- A source credential removed by the friend: that source stops contributing to future indexing; previously indexed content follows the existing per-account indexing behavior.
- Magic link clicked on a different device than requested: link validity is independent of device; single-use still holds.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The portal MUST refuse account creation unless a valid, unused invite code is supplied.
- **FR-002**: Invite codes MUST be operator-generated and single-use; once redeemed they cannot create another account.
- **FR-003**: The portal MUST authenticate people by email + single-use magic link, with no password anywhere in the flow.
- **FR-004**: Magic links MUST expire after a short window and MUST be rejected on reuse or after expiry; issuing a new link MUST invalidate prior unconsumed links for that email.
- **FR-005**: A successful magic-link sign-in MUST establish an authenticated portal session bound to exactly one account.
- **FR-006**: The portal MUST let a signed-in person connect or re-authenticate their Notion via the existing Notion public-OAuth path.
- **FR-007**: The portal MUST let a signed-in person add, edit, rotate, and remove their iCal secret calendar links (multiple allowed) and their Granola API key.
- **FR-008**: All credentials MUST be stored using the existing encrypted per-account vault; the portal MUST never persist or display a secret in plaintext (values shown masked).
- **FR-009**: Rotating or replacing a credential MUST cause the next indexing run to use the new value.
- **FR-010**: A friend's Notion, Granola, and iCal sources MUST each index into that friend's account and be searchable by them through their per-account MCP connection.
- **FR-011**: Account scope for every read MUST be derived from the authenticated session/token, never from user-supplied input, and MUST never expose another account's data.
- **FR-012**: The portal MUST replace the current onboarding landing as the entry point for new friends.
- **FR-013**: The system MUST record usage per account (passive metering) without enforcing any limit in this feature.
- **FR-014**: A friend MUST be able to see the status of their own sources (e.g., connected / last index / errors) for the sources they manage.

### Key Entities *(include if feature involves data)*

- **Account**: A friend's tenant; the unit of data isolation and metering. Owns credentials, sources, and indexed content. Already exists in the backend.
- **Invite code**: A single-use token authorizing one account creation; issued by the operator; tracks redeemed/not-redeemed.
- **Magic-link token**: A single-use, short-lived sign-in token tied to an email/account; tracks issued/consumed/expired.
- **Portal session**: An authenticated session bound to one account after sign-in.
- **Credential (vault secret)**: A per-account encrypted secret of a kind (Notion connection, iCal link, Granola key); stored ciphertext-at-rest; surfaced masked. Already exists in the backend vault.
- **Source / index status**: Per-account, per-source record of connection and last indexing outcome that the friend can view.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A friend with an invite code can go from the portal's front page to a working second brain — Notion connected, at least one calendar and the Granola key set, first index running — in under 10 minutes, without touching a config file, database, or command line.
- **SC-002**: 100% of stored credentials are unreadable at rest (no plaintext secret recoverable from storage), and no stored secret is ever displayed back in full.
- **SC-003**: In a two-account test, 0 documents from one account ever appear in the other account's search results, including under adversarial scope-widening attempts.
- **SC-004**: 100% of magic links are single-use and time-limited (a reused or expired link never grants access), and 100% of account creations are gated by a valid unused invite code.
- **SC-005**: After credential rotation, the next indexing run uses the new value in 100% of cases.
- **SC-006**: The existing operator account (Bruno) continues to index and search with identical results before and after this feature (no measurable regression).

## Out of Scope

- Enforcing free-tier limits (usage is metered passively only; limits come later).
- Billing or payment (e.g., Stripe).
- Teams or collaboration within a single account.
- A temporal entity graph.
- Public open registration (access is invite-only).
- Moving the brain/indexing engine off the single VPS.
- Refactoring or rewriting the existing backend; changes are additive and reuse existing context, vault, and per-account indexing.

## Non-Regression Constraints (must not break)

- Cross-account and cross-workspace isolation must not regress — in particular the workspace guard protecting the shared `nora` data and the `account_id` defense-in-depth. Zero cross-account leakage is the top invariant.
- The already-merged multi-tenant backend (vault, Notion/PAT onboarding, per-account indexing, per-account MCP bearer, passive metering) keeps working unchanged.
- The operator's existing single-account setup (three workspaces configured via environment) continues to index and search identically.
- Existing Notion tooling and its destructive-action confirmation rule, the existing auth paths (bearer and OAuth), the status/health/eval/CI checks, and the single-VPS + process-manager topology all remain intact.

## Assumptions

- The portal UI is served as a static front (Cloudflare Pages, per locked decision); the portal's privileged actions (invite redemption, magic-link issuance/verification, credential read/write, Notion OAuth callback) run on the VPS backend, because secrets must be written to the VPS data store and never handled at the edge.
- Magic links expire in a short window (assumed ~15 minutes) and are single-use; portal sessions persist for a reasonable period until sign-out (exact durations set in planning).
- Invite codes are generated by the operator out-of-band and are single-use (one code = one account).
- An email delivery mechanism is available to send magic links.
- A friend may register multiple iCal calendar links and exactly one Granola API key per account (multiple Granola keys not required for v1).
- Notion connection reuses the existing public-OAuth onboarding path; the portal provides the UI entry to it and a re-authenticate action.
- "First index running" counts as onboarding success; full index completion time depends on source size and is not bounded here.
