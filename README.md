# notion-mcp

A self-hosted [MCP](https://modelcontextprotocol.io/) server that turns Notion
(plus your meeting notes and calendars) into a **searchable second brain** for AI
assistants — and a full Notion toolbelt on top.

Point Claude (Code or claude.ai) at it and you can:

- **Ask your brain anything** — `brain_search` does hybrid semantic + keyword
  retrieval (with a cross-encoder reranker) over everything you've indexed, with
  real relevance scores and source links.
- **Read & write Notion** — 25 tools to search, fetch, create, update, move, and
  comment on pages; query and manage databases / data sources; upload files.
- **Index more than Notion** — pull in Granola meeting notes and Google calendars
  (via iCal, no Google Cloud) so they're searchable alongside your pages.
- **Keep workspaces separate** — route every call to the right Notion workspace,
  and scope what each AI client can read.

Everything runs on one box (Node + Express + PostgreSQL/pgvector + PM2). No SaaS.

---

## Quickstart

```bash
git clone https://github.com/BrunooMoniz/notion-mcp.git
cd notion-mcp
npm install
cp .env.example .env        # then fill in the values (see Configuration below)
npm run build
npm start                   # http://localhost:3456  (GET /health to check)
```

At minimum you need one Notion token (`NOTION_<WORKSPACE>_TOKEN`) and a
`BEARER_TOKEN`. The brain (search/calendars) is optional — add it when you want it
(see [The second brain](#the-second-brain-rag)).

> **Requirements:** Node.js 20+, and a [Notion integration](https://www.notion.so/my-integrations)
> token per workspace. For the brain: PostgreSQL 16 + pgvector and a
> [Voyage AI](https://www.voyageai.com/) API key.

---

## Connect to Claude

### Claude Code (bearer token)

Add to your MCP config:

```json
{
  "mcpServers": {
    "notion-mcp": {
      "type": "streamable-http",
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_BEARER_TOKEN" }
    }
  }
}
```

### claude.ai (OAuth)

1. Open the registration window (one-time, time-boxed):
   ```bash
   curl -X POST https://your-domain.com/admin/open-registration \
     -H "Authorization: Bearer YOUR_BEARER_TOKEN"
   ```
2. Add the server URL (`https://your-domain.com`) as a remote MCP server in
   claude.ai settings.
3. claude.ai auto-discovers the OAuth endpoints via `.well-known` and walks the
   consent flow (PKCE S256).
4. On the consent screen, pick which workspaces to grant and enter your admin
   password. The token is scoped to exactly those workspaces.

---

## The second brain (RAG)

The brain is a local **PostgreSQL + pgvector** index. A background `brain-indexer`
pulls content from your sources, embeds it, and `brain_search` retrieves it.

**What it indexes**

| Source | How |
|--------|-----|
| **Notion** (any workspace) | the indexer crawls shared data sources; `brain_index_url` adds a specific page/DB on demand |
| **Granola** meeting notes | via the Granola API (summary by default; raw transcript opt-in) |
| **Calendars** | from each calendar's private **iCal URL** — multiple calendars, even across Google accounts, no Google Cloud |

**How retrieval works:** vector similarity (Voyage `voyage-3-large` embeddings) +
accent-insensitive Portuguese full-text, fused with Reciprocal Rank Fusion over an
over-fetched candidate pool, then reranked by Voyage `rerank-2.5-lite` for the
final score. Reads are workspace-scoped: a scoped OAuth token never sees another
workspace's chunks.

**Set it up**

1. Provision Postgres + pgvector and apply the schema (fresh installs and
   upgrades both just run the migration runner — it's idempotent):
   ```bash
   npm run migrate
   ```
2. Add `POSTGRES_URL`, `VOYAGE_API_KEY` (and optional `RERANK_*`) to `.env`.
3. Run the indexer (PM2 runs it on a cron; one-off full reindex below):
   ```bash
   npm run reindex
   ```

**Add your calendars (iCal — the simple way, no Google Cloud):** for each
calendar, Google Calendar → *Settings and sharing → Integrate calendar → Secret
address in iCal format* (`.../basic.ics`). List them in `GOOGLE_CAL_ICS`:

```jsonc
GOOGLE_CAL_ICS=[
  {"url":"https://calendar.google.com/calendar/ical/<id>/private-<key>/basic.ics","label":"Personal","workspace":"personal"},
  {"url":"...","label":"Work","workspace":"globalcripto"}
]
```

> ⚠️ iCal URLs are **secrets** (anyone with one can read that calendar). Keep them
> in `.env` only — `data/` and `.env*` are gitignored. Reset a leaked URL from the
> same settings page. (A legacy Google-OAuth calendar indexer also exists as a
> fallback when `GOOGLE_CAL_ICS` is unset.)

---

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `NOTION_<WS>_TOKEN` | yes | Notion integration token per workspace (starts with `ntn_`) |
| `BEARER_TOKEN` | yes | static token for Claude Code / scripts (min 32 chars) |
| `OAUTH_PASSWORD_HASH` | for OAuth | scrypt hash for the consent screen (`node scripts/hash-password.mjs '<pwd>'`) |
| `BASE_URL` | for OAuth | public URL of the server |
| `POSTGRES_URL` | for brain | Postgres + pgvector connection string |
| `VOYAGE_API_KEY` | for brain | embeddings + reranker |
| `RERANK_MODEL` / `RERANK_ENABLED` | no | reranker model / kill switch (default on) |
| `GRANOLA_<WS>_TOKEN` | no | Granola feed per workspace |
| `GRANOLA_INDEX_TRANSCRIPT` | no | index raw transcripts too (default `false`) |
| `GOOGLE_CAL_ICS` | no | calendars to index (JSON array of `{url,label,workspace}`) |
| `INDEXER_CRON` | no | indexer schedule (default hourly) |
| `NORA_READONLY` | no | block writes to a given workspace |

See `.env.example` for the full, commented list.

### Production (PM2)

```bash
pm2 start ecosystem.config.cjs   # notion-mcp + brain-indexer + brain-classifier + nightly reindex
```

---

## Architecture

```
src/
  index.ts       Express server, MCP session lifecycle, auth middleware
  tools.ts       25 Notion tool definitions (Zod schemas + handlers)
  clients.ts     Notion API clients per workspace
  oauth.ts       OAuth 2.1 server (register, authorize, token)
  context.ts     AsyncLocalStorage for per-request auth/scope enforcement
  audit.ts       JSONL audit log writer
  markdown.ts    Bidirectional Markdown <-> Notion block conversion
  rag/           Brain indexer + hybrid search (PostgreSQL + pgvector)
                   calendar-ics-source.ts  iCal calendars
                   granola-source.ts       Granola notes
                   notion-source.ts        Notion pages
  classifier/    LLM page classifier + spaced-repetition Revisitar
scripts/         migrate.mts + migrations/, reindex, eval harness
```

**Notion API** is pinned to `2025-09-03` (multi-source databases, file uploads,
richer comments). **Security:** OAuth 2.1 (PKCE S256, scrypt password, brute-force
lockout), Helmet, CORS locked to claude.ai, rate limiting, a JSONL audit log of
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

**Brain:**

| Tool | Description |
|------|-------------|
| `brain_search` | Hybrid semantic + keyword search, fused via RRF and reranked. Workspace-scoped. Options: `rerank`, `source_type` / `exclude_source_type`, `pessoa`, `date_from` / `date_to`, `workspace`. |
| `brain_index_url` | On-demand indexing of a Notion URL/ID (pages, data sources, databases). |

`brain_search` vs `notion_search`: `notion_search` hits Notion's live `/v1/search`
(title/keyword, current contents); `brain_search` queries the local semantic index
(may be slightly behind, but ranks by meaning + relevance). **Total: 27 tools** (25
Notion + 2 brain).

---

## Adding a workspace

1. Create a Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Add its token as `NOTION_<NAME>_TOKEN` in `.env`.
3. In `src/clients.ts`: add the name to the `Workspace` type, create a client, add
   it to the `getClient()` switch and to `ALL_WORKSPACES`.

---

## Contributing

`main` is protected — all changes land via pull request.

```bash
git checkout dev
git checkout -b feat/your-change   # branch off dev
# ...commit...
git push -u origin feat/your-change
gh pr create --base dev            # PR into dev; promote dev -> main when ready
```

Run `npm test` (node:test) and `npm run build` before opening a PR.

## License

MIT
