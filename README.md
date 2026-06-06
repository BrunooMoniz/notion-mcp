# Zinom.ai

**Um segundo cérebro poderoso para a sua IA preferida.** Entregue o contexto certo
e tenha o melhor assistente onde você preferir.

Zinom.ai une suas **reuniões** (Granola), sua **base de conhecimento** (Notion) e
sua **rotina** (Calendar) num índice pesquisável, e expõe tudo isso para o seu
assistente de IA via [MCP](https://modelcontextprotocol.io/) — para ele buscar
contexto e ainda **criar tarefas, páginas e sistemas no Notion** por você.

It's a self-hosted MCP server (Node + Express + PostgreSQL/pgvector + PM2) with a
multi-tenant, self-service portal on top. No SaaS — everything runs on one box.

```
Your AI (Claude Code, claude.ai, Cursor, …)  ──MCP──▶  Zinom.ai  ──▶  your Notion · Granola · Calendar
```

- **Ask your brain anything** — `brain_search` does hybrid semantic + keyword
  retrieval (cross-encoder reranker) over everything you've indexed, with real
  relevance scores and source links.
- **Read & write Notion** — 25 tools to search, fetch, create, update, move, and
  comment on pages; query and manage databases / data sources; upload files.
- **Index more than Notion** — Granola meeting notes and Google calendars (via
  iCal, no Google Cloud), searchable alongside your pages.
- **Multi-tenant & self-service** — friends onboard themselves through the
  **portal**, connect their own sources, and query **only their own brain**.

---

## Two ways to use it

**1. The hosted product (Zinom.ai).** A non-technical person opens the portal,
joins by invite, signs in with a magic link, connects their sources, and plugs
their AI assistant in. No `.env`, no psql, no command line. See
[The portal](#the-portal-multi-tenant-self-service).

**2. Self-host the MCP server.** Run it on your own box for a single operator (or
many). See [Quickstart](#quickstart) and [Run with Docker](#run-with-docker).

---

## The portal (multi-tenant, self-service)

The portal (served at the site root, e.g. `https://zinom.ai`) lets each person run
their own second brain, fully isolated from everyone else's.

**Onboarding flow**

1. **Invite** — the operator mints a single-use code: `npm run make-invite`.
2. **Sign in** — the friend enters the code + their email and gets a **magic link**
   (passwordless). No password is ever set.
3. **Connect sources** — from one page they connect:
   - **Notion** — 1-click **OAuth** *(recommended)* or paste a **Personal Access
     Token** *(easier to integrate; see the in-app tutorial)*.
   - **Calendars** — add one or more secret **iCal** links.
   - **Granola** — paste their API key.
4. **Index** — their Notion + Granola + iCal index into **their own account**.
5. **Connect their AI** — they generate a per-account access token (for Claude
   Code / Cursor) or add Zinom as a **custom connector in claude.ai** and authorize
   with an emailed 6-digit code.

**Isolation (the top invariant).** Every row carries an `account_id`; every search
is hard-scoped to the authenticated account, derived from the session/token and
**never** from request input. One account can never see another's data. Secrets
live in a per-account **AES-256-GCM vault** (`account_secrets`) and are shown only
masked, never in plaintext.

**Admin.** `GET /admin` (operator `BEARER_TOKEN`-gated, like `/status`) renders a
read-only dashboard: accounts, connected sources, MCP tokens, last index runs,
usage metering, and invite stats.

**Portal surface**

| Path | What |
|------|------|
| `/` | Landing + sign-in (invite / magic link) |
| `/portal/register`, `/portal/login`, `/portal/verify` | Magic-link auth |
| `/portal/sources`, `/portal/ical`, `/portal/granola`, `/portal/notion/connect`, `/portal/notion/pat` | Manage credentials |
| `/portal/mcp-token`, `/portal/reindex` | Per-account MCP token + indexing |
| `/admin` | Operator dashboard |
| `/mcp`, `/oauth/*` | MCP endpoint + OAuth (operator + per-account friend flow) |

---

## Quickstart (self-host)

```bash
git clone https://github.com/BrunooMoniz/notion-mcp.git
cd notion-mcp
npm install
cp .env.example .env        # fill in values (see Configuration)
npm run migrate             # apply DB schema (Postgres + pgvector)
npm run build
npm start                   # http://localhost:3456  (GET /health to check)
```

At minimum you need one Notion token (`NOTION_<WORKSPACE>_TOKEN`) and a
`BEARER_TOKEN`. The brain, portal, and email are optional layers — add them when
you want them.

> **Requirements:** Node.js 20+. For the brain: PostgreSQL 16 + pgvector and a
> [Voyage AI](https://www.voyageai.com/) key. For the portal: a `SECRETS_KEY` and
> (for real emails) a [Resend](https://resend.com) key.

---

## Run with Docker

The included `docker compose` stack brings the whole thing up from zero —
Postgres + pgvector, the MCP server, the brain indexer, and the classifier — and
runs the DB migrations automatically.

```bash
cp .env.example .env        # fill in tokens/keys
docker compose up -d        # builds the image, starts db -> migrate -> app
```

Server on **http://localhost:3456** (`GET /health`). Compose provides Postgres
(`pgvector/pgvector:pg16`) and sets `POSTGRES_URL` for you; a one-shot `migrate`
service applies the schema before the app boots. You still fill in tokens/keys in
`.env`. (Production on the VPS uses PM2 — see [Production](#production-pm2).)

---

## Connect your AI

### Per-account (friends, via the portal)

- **claude.ai / Claude Desktop:** Settings → Connectors → *Add custom connector* →
  paste the server URL (e.g. `https://zinom.ai/mcp`). The authorize screen signs
  the friend in (portal session = 1 click, otherwise email + 6-digit code) and
  issues a token scoped to **their** account.
- **Claude Code / Cursor:** generate a token in the portal and run the shown
  command:
  ```bash
  claude mcp add --transport http zinom https://zinom.ai/mcp --header "Authorization: Bearer acct_…"
  ```

### Operator (single-tenant self-host)

```jsonc
// Claude Code MCP config — static bearer, full access
{ "mcpServers": { "zinom": {
  "type": "streamable-http",
  "url": "https://your-domain.com/mcp",
  "headers": { "Authorization": "Bearer YOUR_BEARER_TOKEN" }
} } }
```

For claude.ai as the operator: open the registration window
(`curl -X POST .../admin/open-registration -H "Authorization: Bearer YOUR_BEARER_TOKEN"`),
add the server URL in claude.ai, and on the consent screen pick workspaces + enter
your admin password (PKCE S256). The token is scoped to those workspaces.

---

## The second brain (RAG)

A local **PostgreSQL + pgvector** index. A background `brain-indexer` pulls from
your sources, embeds it, and `brain_search` retrieves it.

| Source | How |
|--------|-----|
| **Notion** | indexer crawls data sources shared with the integration; `brain_index_url` adds a specific page/DB on demand |
| **Granola** | via the Granola API (summary by default; raw transcript opt-in) |
| **Calendars** | each calendar's private **iCal URL** — multiple calendars, even across Google accounts, no Google Cloud |
| **Web** | `brain_index_web` adds any URL on demand; optional periodic feed via `WEB_SOURCES` |

**Retrieval:** Voyage `voyage-3-large` embeddings + accent-insensitive Portuguese
full-text, fused with Reciprocal Rank Fusion over an over-fetched pool, then
reranked by Voyage `rerank-2.5-lite`. Reads are scoped by **account** (multi-tenant
hard guard) and by **workspace** (defense in depth).

**Calendars (iCal):** for each calendar, Google Calendar → *Settings and sharing →
Integrate calendar → Secret address in iCal format* (`.../basic.ics`). The operator
lists them in `GOOGLE_CAL_ICS`; portal friends add them per-account. iCal URLs are
**secrets** — `.env`/vault only.

---

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | For | Purpose |
|----------|-----|---------|
| `NOTION_<WS>_TOKEN` | operator | Notion token per workspace (`ntn_…`) |
| `BEARER_TOKEN` | operator | static token for Claude Code / `/admin` / scripts (min 32 chars) |
| `OAUTH_PASSWORD_HASH` | OAuth | scrypt hash for the operator consent (`node scripts/hash-password.mjs '<pwd>'`) |
| `BASE_URL` | OAuth/portal | public URL (e.g. `https://zinom.ai`) — used for links, OAuth metadata, MCP URL |
| `POSTGRES_URL` | brain | Postgres + pgvector connection string |
| `VOYAGE_API_KEY` | brain | embeddings + reranker |
| `SECRETS_KEY` | portal | 64 hex chars (`openssl rand -hex 32`) — AES-256-GCM vault key |
| `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET` | portal | Notion public-OAuth app (for friend "Connect Notion") |
| `RESEND_API_KEY` / `PORTAL_EMAIL_FROM` | portal | transactional email (magic links + login codes) |
| `GRANOLA_<WS>_TOKEN`, `GOOGLE_CAL_ICS`, `INDEXER_CRON`, `RERANK_*`, `NORA_READONLY` | no | sources / schedule / tuning |
| `PORTAL_COOKIE_SECURE`, `PORTAL_SESSION_COOKIE_DOMAIN`, `PORTAL_PAGES_ORIGIN` | no | cookie/CORS tuning for split-domain deploys |

In dev/test, `PORTAL_EMAIL_DEV=1` logs the magic link / code instead of sending.
See `.env.example` for the full, commented list.

### Production (PM2)

```bash
pm2 start ecosystem.config.cjs   # notion-mcp + brain-indexer + brain-classifier + nightly reindex
```

The hosted Zinom.ai routes `zinom.ai` → the VPS (the app at `localhost:3456`) via
Cloudflare. Operational runbook: `specs/001-account-portal/DEPLOY.md`.

---

## Architecture

```
src/
  index.ts          Express server, MCP session lifecycle, auth middleware
  tools.ts          25 Notion tool definitions (Zod schemas + handlers)
  clients.ts        Notion API clients per workspace
  oauth.ts          OAuth 2.1 server — operator (password) + friend (per-account) flows
  account-bearer.ts per-account MCP bearer tokens (hash at rest)
  account-tokens.ts per-account vault-token resolution
  secrets.ts        AES-256-GCM per-account secret vault
  context.ts        AsyncLocalStorage — per-request account + workspace scope
  notion-oauth.ts   Notion public-OAuth + PAT onboarding
  portal/           friend portal: session, invites, magic-link, email, sources, routes
  admin/            operator dashboard (read-only)
  rag/              brain indexer + hybrid search (pgvector)
                      index-account.ts  per-account indexing (Notion + Granola + iCal)
                      *-source.ts        notion / granola / calendar-ics / web sources
  classifier/       LLM page classifier + spaced-repetition Revisitar
scripts/            migrate.mts + migrations/0001..0007, make-invite.mts, reindex, eval
portal/             static front (landing, dashboard) served at the site root
tests/e2e/          Playwright e2e (portal flows)
```

**Multi-tenant primitives:** `account` / `account_workspaces` / `account_secrets`
/ `account_api_tokens` / `usage_log` (migrations 0005–0006) + `invite_codes` /
`magic_links` / `portal_sessions` + `account.email` (0007). Per-account chunks are
namespaced via `prefixChunkIds(accountId)` and every read is `account_id`-scoped.

**Notion API** pinned to `2025-09-03`. **Security:** OAuth 2.1 (PKCE S256, scrypt
password, brute-force lockout), per-account magic links + bearers stored as SHA-256
hashes, AES-256-GCM secret vault, Helmet, CORS, rate limiting, a JSONL audit log of
every write, and `confirm: true` guard rails on destructive tools.

---

## Tool reference

**Read:** `notion_search`, `notion_fetch`, `notion_get_page`,
`notion_get_block_children`, `notion_query_database`, `notion_get_database_schema`,
`notion_list_data_sources`, `notion_get_data_source_schema`,
`notion_query_data_source`, `notion_list_users`, `notion_get_self`,
`notion_list_comments`.

**Write (non-destructive):** `notion_create_page`, `notion_update_page`,
`notion_append_blocks`, `notion_update_page_content`, `notion_move_page`,
`notion_create_comment`, `notion_create_database`, `notion_update_database`.

**Write (DESTRUCTIVE — require `confirm: true`):** `notion_replace_page_content`,
`notion_delete_page`, `notion_update_database` with `remove_columns`.

**Files:** `notion_create_file_upload`, `notion_send_file_upload`,
`notion_complete_file_upload`.

**Brain:** `brain_search` (hybrid semantic + keyword, reranked, account/workspace
scoped), `brain_index_url` (index a Notion URL/ID on demand), `brain_index_web`
(index any web page/article). **Total: 27 tools.**

---

## Contributing

`main` is protected — changes land via pull request.

```bash
git checkout -b feat/your-change
# ...commit...
gh pr create --base main
```

Run `npm test` (node:test), `npm run build`, and `npx playwright test` (e2e) before
opening a PR.

## License

MIT
