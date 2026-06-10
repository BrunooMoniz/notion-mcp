# notion-mcp

Notion MCP server with multi-workspace support. TypeScript + Express, deployed via PM2.

## Quick reference

```bash
npm run dev          # start dev server (tsx, hot reload)
npm run build        # compile TypeScript to dist/
npm start            # run compiled server
pm2 start ecosystem.config.cjs  # production
```

Port: 3456 (default). Health check: `GET /health`.

## Project structure

```
src/
  index.ts       # Express server, session lifecycle, auth middleware, INSTRUCTIONS
  tools.ts       # ~24 Notion tool definitions (Zod schemas + handlers)
  clients.ts     # Notion clients + NOTION_API_VERSION + notionFetch raw helper
  oauth.ts       # OAuth 2.1 server (RFC 7591/8414, PKCE, consent screen)
  context.ts     # AsyncLocalStorage for per-request scope enforcement
  audit.ts       # JSONL audit log for write operations
  markdown.ts    # Markdown <-> Notion block conversion
  rag/           # Brain indexer + hybrid search (PostgreSQL + pgvector)
  classifier/    # LLM page classifier + spaced-repetition Revisitar
```

## Brain RAG (second brain)

The brain is a **PostgreSQL + pgvector** store. Three PM2 processes —
`notion-mcp`, `brain-indexer`, `brain-classifier`, plus the nightly
`brain-reindex-nightly` cron — write to the same Postgres concurrently; Postgres
MVCC handles concurrency, so there is no writer-serialization constraint.

Retrieval (`src/rag/search.ts`):
- **Hybrid search** — semantic (Voyage `voyage-3-large` embeddings) + keyword
  (Postgres full-text), fused with Reciprocal Rank Fusion over an over-fetched
  candidate pool, then reranked.
- **Reranker** — Voyage `rerank-2.5-lite` cross-encoder produces the real
  relevance score. Env kill switch `RERANK_ENABLED=false` hard-disables it
  (graceful fallback to normalized RRF on any rerank failure).
- **HNSW index** on the `embedding` column (`vector_cosine_ops`, `m=16`,
  `ef_construction=200`) — replaces the recall-lossy ivfflat.
- **Accent-insensitive full text** — the `tsv` generated column uses the
  `portuguese_unaccent` text-search configuration (a dictionary mapping that
  keeps `to_tsvector` IMMUTABLE), so `reunião`/`reuniao` and `são`/`sao` match.
- **pg_trgm GIN** on raw `text` for proper-noun / partial fallback (ILIKE).

Brain MCP tools (registered in `index.ts`):
- **`brain_search`** — hybrid semantic+keyword search with rerank. Options:
  `rerank` (default true), `source_type` / `exclude_source_type`, `pessoa`,
  `date_from` / `date_to`, `workspace`.
- **`brain_index_url`** — on-demand indexing of a Notion URL/ID into the brain.
- **`brain_index_web`** — on-demand indexing of an arbitrary web page/article by
  URL (`source_type="web"`). Zero-dep: Node global `fetch` + hand-rolled
  HTML→text (`src/rag/sources/web-source.ts`), replace-on-write.

**Connector framework (F2.2)** — sources implement the `Source` contract
(`src/rag/types.ts`) and run through the generic, dependency-injected
`runSourcePass()` (`src/rag/sources/runner.ts`); the shared doc→chunks transform
lives in `src/rag/index-document.ts`. The three built-in passes (notion/granola/
calendar) keep their bespoke logic; new feeds plug in via `Source`. The web feed
is periodic via `WEB_SOURCES` (JSON `[{url,workspace,label?}]`; unset = no-op).

**Temporal facts (F2.3, OFF by default)** — `brain_facts` (subject-predicate-
object + `valid_from`/`valid_to`) in plain Postgres (no graph DB). The classifier
extracts facts (Haiku) ONLY when `FACTS_ENABLED=true`; unset = zero new behavior.
Helpers in `src/rag/facts.ts` (pure) + `facts-storage.ts` + `facts-extractor.ts`.

**Workspace scoping** — brain reads are workspace-scoped via
`getAllowedWorkspaces()` (`src/getAllowedWorkspaces.ts`): a scoped OAuth token
only sees its granted workspaces (intersected with any caller `workspace`
filter; empty intersection returns zero rows — no cross-workspace leak). Bearer
("all") tokens and out-of-request contexts (cron / `npm run eval`) are
unfiltered. `brain_index_url` calls `assertWorkspaceScope()` before writing.

**Calendars** — indexed from per-calendar **iCal secret URLs** via
`src/rag/calendar-ics-source.ts` (env `GOOGLE_CAL_ICS`, a JSON array of
`{url,label,workspace}`). This is account-agnostic and needs no Google Cloud, so
it covers multiple calendars across multiple Google accounts. The legacy
Google-OAuth indexer (`src/rag/calendar-source.ts`, `src/google/`) still works as
a fallback when `GOOGLE_CAL_ICS` is unset. iCal URLs are secrets — `.env` only.

Migrations: ordered SQL in `scripts/migrations/*.sql`, applied by the idempotent
runner `npm run migrate` (tracks applied versions in `schema_migrations`). Fresh
installs and upgrades both just run `npm run migrate`; `--dry` (or `MIGRATE_DRY=1`)
lists pending migrations without applying. (`scripts/verify-f2.sql` is a manual
post-migration sanity check.)

## Notion API version

Pinned to `2025-09-03` (see `NOTION_API_VERSION` in `clients.ts`). This unlocks:
- multi-source databases (`data_sources` array on Database object, separate `/v1/data_sources/:id` endpoints)
- file uploads (`/v1/file_uploads`)
- richer comments API

For endpoints not yet typed by `@notionhq/client`, use `notionFetch(workspace, path, init)` — it auths with the workspace's token and pins the version header.

## Destructive operations

Tools that wipe data (`notion_delete_page`, `notion_replace_page_content`, `notion_update_database` with `remove_columns`) require `confirm: true`. The handler refuses without it. Don't add fallback paths around this — the prompt-level safety rules in `INSTRUCTIONS` reinforce the same convention.

## Workspaces

Three configured: `personal`, `globalcripto`, `nora`. Each maps to a Notion integration token in `.env`. To add a new workspace, edit `src/clients.ts` (type, client instance, switch case, ALL_WORKSPACES array).

## Auth

Two paths:
- **Bearer token** (Claude Code): `BEARER_TOKEN` env var, full access to all workspaces
- **OAuth** (Claude.ai): dynamic client registration with enrollment window, PKCE S256, per-workspace scopes chosen at consent time

## Key conventions

- Every tool takes a `workspace` parameter (Zod enum)
- Write tools call `auditWrite()` for JSONL logging
- `markdownToBlocks()` / `blocksToMarkdown()` handle Markdown I/O
- `assertWorkspaceScope()` in context.ts enforces OAuth scope per request
- Error handling is wrapped at the `server.tool` level in tools.ts -- individual handlers don't need try/catch

## Retrieval eval (F8)

If you alter `src/rag/search.ts`, `src/rag/chunker.ts`, `src/rag/granola-source.ts`, or any embeddings/reranking path:
1. Run `npm run eval` on the VPS (`ssh zinom-vps "cd /home/moniz/notion-mcp && ./node_modules/.bin/tsx scripts/eval/run-eval.mts"`).
2. Compare Recall@5 and MRR against `scripts/eval/BASELINE.md` (F8 baseline: Recall@5=0.875, MRR=0.604; post-3a: R@5=0.917, MRR=0.616).
3. Only commit changes that maintain or improve both metrics. Document results in `scripts/eval/RESULTS.md`.

## Friend Account Portal (001-account-portal)

Self-service portal so a non-technical friend onboards their own second brain
without `.env`/psql/operator help. Lives in `src/portal/*` (backend) + `portal/*`
(static front, served at the site root, replacing the old `/onboard` landing).
Mounted into the main server in `index.ts`; additive, the existing backend is
untouched.

- **Auth**: email + single-use magic link (no password). `/portal/register`
  (invite-gated) and `/portal/login` issue a 15-min link emailed via Resend
  (`src/portal/email.ts`, zero-dep `fetch`). `/portal/verify` consumes it and sets
  a server-side session cookie (`portal_sessions`, opaque cookie, SHA-256 hash at
  rest — `src/portal/session.ts`). Account scope always comes from the session,
  never from request input.
- **Invites**: operator-only, single-use, hash at rest (`src/portal/invites.ts`).
  Mint one with `npm run make-invite -- --label "..."` (prints the code once).
- **Credentials**: friend self-manages Notion (OAuth, reuses the registered
  `/notion/callback` via `src/portal/notion-link.ts`), multiple iCal links, one
  Granola key — all in the existing encrypted vault (`account_secrets`), shown
  masked (`src/portal/sources.ts`). iCal links are a JSON array under vault kind
  `ical`; Granola is one string under kind `granola`.
- **Indexing**: `POST /portal/reindex` runs `indexAccount()`, which now indexes
  the friend's Notion **+ Granola + iCal** per account, isolated by `account_id`
  + `prefixChunkIds` (`src/rag/index-account.ts`; helpers in
  `src/rag/account-sources.ts`). The friend's source workspace is registered in
  `account_workspaces` so their per-account bearer can see those chunks.
- **Schema**: migration `0007_account_portal.sql` (invite_codes, magic_links,
  portal_sessions, `account.email`).
- **Local dev**: `npm run dev:portal` runs `src/portal/dev-server.ts` (portal only,
  no pgvector/Notion needed) against a plain Postgres seeded with
  `scripts/portal-dev-schema.sql`. E2E: `npx playwright test` (tests/e2e/).
- **Deploy**: `specs/001-account-portal/DEPLOY.md` (served from the VPS same-origin;
  Cloudflare Pages deferred until a shared domain exists — cross-site cookie).

## Environment variables

Required: `NOTION_PERSONAL_TOKEN`, `NOTION_GLOBALCRIPTO_TOKEN`, `NOTION_NORA_TOKEN`, `OAUTH_PASSWORD_HASH`.
Optional: `BEARER_TOKEN`, `BASE_URL`, `PORT`, `NORA_READONLY`, `AUDIT_LOG_PATH`, `ENROLLMENT_WINDOW_MINUTES`.
Portal: `RESEND_API_KEY`, `PORTAL_EMAIL_FROM` (magic-link email), `NOTION_OAUTH_CLIENT_ID`/`NOTION_OAUTH_CLIENT_SECRET` (Notion connect). Dev/test: `PORTAL_EMAIL_DEV=1` (capture link, no send), `PORTAL_PORT`, `PORTAL_TEST_MODE=1`. Cross-origin (future Pages): `PORTAL_SESSION_COOKIE_DOMAIN`, `PORTAL_PAGES_ORIGIN`, `PORTAL_COOKIE_SECURE`.

Generate password hash: `node scripts/hash-password.mjs 'password'`

<!-- SPECKIT START -->
Active feature plan: `specs/001-account-portal/plan.md` (Friend Account Portal —
self-service onboarding on the existing multi-tenant backend). See also
`research.md`, `data-model.md`, `contracts/portal-api.md`, `quickstart.md` in the
same directory for technical context, structure, and validation steps.
<!-- SPECKIT END -->
