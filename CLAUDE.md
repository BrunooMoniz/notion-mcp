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
  rag/           # Brain indexer + search (PGLite vector store)
  classifier/    # LLM page classifier + spaced-repetition Revisitar
```

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

## Environment variables

Required: `NOTION_PERSONAL_TOKEN`, `NOTION_GLOBALCRIPTO_TOKEN`, `NOTION_NORA_TOKEN`, `OAUTH_PASSWORD_HASH`.
Optional: `BEARER_TOKEN`, `BASE_URL`, `PORT`, `NORA_READONLY`, `AUDIT_LOG_PATH`, `ENROLLMENT_WINDOW_MINUTES`.

Generate password hash: `node scripts/hash-password.mjs 'password'`
