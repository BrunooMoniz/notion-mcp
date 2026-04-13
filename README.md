# notion-mcp

A self-hosted [MCP](https://modelcontextprotocol.io/) server that connects AI assistants to the Notion API. Supports multiple workspaces, OAuth for Claude.ai, and bearer tokens for Claude Code.

## Features

- **Multi-workspace** -- route requests to different Notion integrations by passing a `workspace` parameter on every tool call
- **16 tools** -- search, fetch, create, update, delete, and move pages; query and manage databases; append and replace content with Markdown or raw blocks
- **Markdown I/O** -- write content as Markdown and it gets converted to Notion blocks automatically; read pages back as Markdown
- **OAuth 2.1 flow** -- dynamic client registration (RFC 7591), PKCE (S256), consent screen with per-workspace scope selection, scrypt-hashed admin password
- **Bearer token auth** -- for direct access from Claude Code or scripts
- **Audit log** -- every write operation is logged as JSONL with timestamp, tool, workspace, auth type, client, and IP
- **Session management** -- up to 20 concurrent MCP sessions with 30-minute TTL and automatic eviction
- **Security** -- Helmet headers, CORS locked to `claude.ai`, rate limiting, brute-force protection, enrollment window for client registration

## Architecture

```
src/
  index.ts       Express server, MCP session lifecycle, auth middleware
  tools.ts       All 16 Notion tool definitions (Zod schemas + handlers)
  clients.ts     Notion API clients per workspace
  oauth.ts       Full OAuth 2.1 server (register, authorize, token)
  context.ts     AsyncLocalStorage for per-request auth/scope enforcement
  audit.ts       JSONL audit log writer
  markdown.ts    Bidirectional Markdown <-> Notion block conversion
```

## Setup

### Prerequisites

- Node.js 20+
- A [Notion integration](https://www.notion.so/my-integrations) for each workspace you want to connect

### 1. Clone and install

```bash
git clone https://github.com/brunomoniz/notion-mcp.git
cd notion-mcp
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
# One Notion integration token per workspace (must start with ntn_)
NOTION_PERSONAL_TOKEN=ntn_...
NOTION_GLOBALCRIPTO_TOKEN=ntn_...
NOTION_NORA_TOKEN=ntn_...

# Static bearer token for Claude Code (min 32 chars)
BEARER_TOKEN=your-secure-token-here

# Scrypt hash for the OAuth consent screen password
# Generate with: node scripts/hash-password.mjs 'your-password'
OAUTH_PASSWORD_HASH=salt-hex:hash-hex

# Optional
BASE_URL=https://your-domain.com   # defaults to localhost
PORT=3456
NORA_READONLY=true                 # block writes to a specific workspace
AUDIT_LOG_PATH=./logs/audit.log
ENROLLMENT_WINDOW_MINUTES=60       # how long client registration stays open
```

### 3. Generate the password hash

```bash
node scripts/hash-password.mjs 'your-admin-password'
```

Copy the output into `OAUTH_PASSWORD_HASH`.

### 4. Build and run

```bash
npm run build
npm start
```

For development:

```bash
npm run dev
```

### 5. Production (PM2)

```bash
pm2 start ecosystem.config.cjs
```

## Connecting to Claude

### Claude Code (bearer token)

Add to your MCP config:

```json
{
  "mcpServers": {
    "notion-mcp": {
      "type": "streamable-http",
      "url": "https://your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_BEARER_TOKEN"
      }
    }
  }
}
```

### Claude.ai (OAuth)

1. Open the registration window:
   ```bash
   curl -X POST https://your-domain.com/admin/open-registration \
     -H "Authorization: Bearer YOUR_BEARER_TOKEN"
   ```
2. Add the server URL (`https://your-domain.com`) as a remote MCP server in Claude.ai settings
3. Claude.ai will auto-discover the OAuth endpoints via `.well-known` and walk through the consent flow
4. On the consent screen, select which workspaces to grant access to and enter your admin password

## Available Tools

| Tool | Description |
|------|-------------|
| `notion_search` | Search pages and databases |
| `notion_fetch` | Rich fetch by URL or ID, returns Markdown + properties |
| `notion_get_page` | Raw page JSON with block children |
| `notion_query_database` | Query with filters and sorts |
| `notion_get_database_schema` | Get database column definitions |
| `notion_list_users` | List workspace users |
| `notion_create_page` | Create page with Markdown or raw blocks |
| `notion_update_page` | Update page properties |
| `notion_append_blocks` | Append content to a page |
| `notion_update_page_content` | Search-and-replace inside page content |
| `notion_replace_page_content` | Replace all page content |
| `notion_create_database` | Create a database with schema |
| `notion_update_database` | Add, rename, or remove database columns |
| `notion_move_page` | Move page to a different parent |
| `notion_delete_page` | Archive a page |

## Adding Workspaces

1. Create a new Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Add the token as `NOTION_<NAME>_TOKEN` in `.env`
3. Add the workspace to the `Workspace` type in `src/clients.ts`
4. Create a client instance and add it to `getClient()`
5. Add it to `ALL_WORKSPACES`

## License

MIT
