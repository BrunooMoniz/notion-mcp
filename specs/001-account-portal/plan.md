# Implementation Plan: Friend Account Portal (self-service onboarding)

**Branch**: `001-account-portal` | **Date**: 2026-06-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-account-portal/spec.md`

## Summary

Build a friend-facing, self-service portal on top of the already-shipped multi-tenant backend so a non-technical person can: (1) join by single-use invite code and sign in with an emailed magic link (no password), (2) self-manage their own source credentials (Notion OAuth, multiple iCal links, one Granola key) through the existing encrypted per-account vault, and (3) have those three sources index into their own account, searchable only by them via their per-account MCP bearer. The portal **replaces** the current minimal `/onboard` landing.

Technical approach: a **static SPA on Cloudflare Pages** (locked decision) for the UI, plus a new set of **privileged `/portal/*` HTTP routes on the existing VPS Express server** that own invite redemption, magic-link issuance/verification, portal sessions, and credential read/write. All persistence reuses the existing Postgres + `account_secrets` vault; the two genuinely new capabilities are **transactional email** (for magic links, does not exist yet) and a **cookie-based portal session** (distinct from the MCP `acct_` bearer). The backend multi-tenant invariants (vault, Notion onboarding, per-account indexing, per-account bearer, passive metering, cross-account isolation) are reused unchanged; all changes are additive.

## Technical Context

**Language/Version**: TypeScript (Node.js 20+), ESM, `tsx` for dev/test. Frontend: static HTML/CSS + vanilla JS (no framework build) served by Cloudflare Pages.

**Primary Dependencies**: Existing — Express, `@notionhq/client`, `pg` (+ pgvector), Node `crypto`. New — none at the npm level if email uses a transactional HTTP API via global `fetch` (matches the repo's zero-dep, fetch-based pattern used by `web-source.ts` / Granola). Decision deferred to research (see Email below); flagged because a new outbound integration is involved.

**Storage**: PostgreSQL (existing). New tables via one additive migration `scripts/migrations/0007_account_portal.sql`: `invite_codes`, `magic_links`, `portal_sessions`, and an additive `email` column on `account`. Secrets continue to live in the existing `account_secrets` vault (AES-256-GCM, `secrets.ts`).

**Testing**: Node native `node:test` via `tsx --test` (existing `npm run test`), with `__setPoolForTest()` stub-pool seam for unit/integration of token/session/invite logic. **Playwright** added for the US1/US2/US3 end-to-end flows the spec's Independent Tests require (no e2e harness exists today).

**Target Platform**: Linux VPS (single host, PM2-managed `notion-mcp` process) for the API; Cloudflare Pages for the static front.

**Project Type**: Web application — existing backend API (`src/`) + new static frontend (`portal/`).

**Performance Goals**: Not throughput-bound. SC-001 target: invite-code front page → first index running in **under 10 minutes** of human interaction. Magic-link verify and credential writes are single-request, sub-second operations.

**Constraints**: Single shared VPS (invite-gated, not public). Secrets never leave the VPS in plaintext and are never written at the edge. Portal and API **must share a registrable domain** (e.g. `portal.example` + `api.example`) so the session cookie is same-site (`SameSite=Lax`, `Secure`, `HttpOnly`) and survives third-party-cookie phase-out — this is the chosen alternative to cross-site cookies (see research). Magic links expire in ~15 min, single-use; sessions ~30 days sliding.

**Scale/Scope**: Tens of friend accounts (not thousands). Scope is the portal surface only; the indexing engine, RAG, and MCP layer are reused as-is.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an **unfilled template** (placeholder principles). In its absence, gates are derived from the operative project rules in `CLAUDE.md` (global + project) and the spec's Non-Regression Constraints:

| Gate | Source | Status |
|------|--------|--------|
| **Test-first / Definition of Done** — acceptance verified by machine (unit + Playwright), no test weakened to pass | CLAUDE.md "Definição de pronto" | PASS — each user story has an Independent Test; Phase 1 defines the e2e + unit coverage. |
| **Security — no secret in code/repo; secrets only in env/vault; ciphertext at rest** | CLAUDE.md "Segurança"; FR-008, SC-002 | PASS — reuses existing AES-256-GCM vault; invite/magic/session tokens stored as SHA-256 hashes; email API key via env. |
| **Surgical & additive — touch only what's asked, no refactor of surrounding backend** | CLAUDE.md "Cirúrgico"; spec Out-of-Scope | PASS — new `/portal/*` routes + new `portal/` front + one additive migration; existing routes/auth/indexing unchanged. |
| **No new dependency without justification** | CLAUDE.md "Como trabalhar" | CONDITIONAL — email transport is a new outbound integration; research picks the option that avoids an npm dependency (HTTP API via `fetch`) and flags the operator setup (domain verification, API key) for explicit approval. |
| **Non-regression — zero cross-account leakage; operator (Bruno) setup unchanged; existing auth/Notion/health intact** | spec Non-Regression Constraints; SC-003, SC-006 | PASS — account scope still derived from session/token server-side (FR-011); operator continues on env/bearer path untouched; isolation test (SC-003) in Playwright suite. |

No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-account-portal/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── portal-api.md    # /portal/* HTTP contract
├── checklists/          # (pre-existing)
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── portal/                      # NEW — portal backend module
│   ├── routes.ts                # /portal/* Express router (register, login, verify, logout, me, sources)
│   ├── invites.ts               # invite code issue (operator) + redeem/validate
│   ├── magic-link.ts            # issue / verify single-use, short-lived tokens
│   ├── session.ts               # cookie-based portal session create/resolve/destroy (hash at rest)
│   ├── email.ts                 # transactional email send (magic links) via fetch
│   ├── sources.ts               # read source/index status; write iCal[] + Granola via vault
│   └── __tests__/*.test.ts      # unit/integration (stub pool seam)
├── secrets.ts                   # REUSED unchanged (vault)
├── account-bearer.ts            # REUSED unchanged (acct_ MCP bearer)
├── notion-routes.ts             # MODIFIED — landing() replaced to point at portal; OAuth state carries portal account_id
├── notion-oauth.ts              # MODIFIED — callback associates Notion workspace to an existing portal account when state carries one
├── rag/index-account.ts         # MODIFIED if needed — ensure per-account pass consumes vault granola + ical[] (verify in research)
└── index.ts                     # MODIFIED — mount /portal router; CORS for Pages origin; cookie parsing

scripts/
├── migrations/0007_account_portal.sql   # NEW — invite_codes, magic_links, portal_sessions, account.email
└── make-invite.mts                       # NEW — operator CLI: generate single-use invite code, print once

portal/                          # NEW — static SPA (Cloudflare Pages)
├── index.html                   # front page: invite code + email
├── check-email.html             # "link sent" confirmation
├── app.html                     # signed-in dashboard: sources management + status
├── app.js / styles.css          # vanilla JS calling /portal/* with credentials:'include'
└── (Pages deploy config)

tests/
└── e2e/                         # NEW — Playwright
    ├── us1-invite-magic-link.spec.ts
    ├── us2-credentials.spec.ts
    └── us3-isolation.spec.ts
```

**Structure Decision**: Web application. The backend portal lives as a self-contained `src/portal/` module mounted into the existing Express app (mirrors how `notion-routes.ts` is a cohesive router), keeping the change surgical and the existing modules reusable. The static front is an isolated `portal/` directory deployed to Cloudflare Pages (the locked hosting decision), kept framework-free to match the repo's no-frontend-build reality and the non-technical owner's simplicity bar. One additive migration; no existing table or route is rewritten.

## Complexity Tracking

No constitution violations to justify.
