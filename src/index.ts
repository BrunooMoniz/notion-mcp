import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { registerBrainSearchTool } from "./rag/brain-tool.js";
import { createOAuthRouter, getAccessTokenInfo } from "./oauth.js";
import { requestContext, type RequestContext } from "./context.js";

const BASE_URL = process.env.BASE_URL ?? "https://vps-1200754.tail30b723.ts.net";

const INSTRUCTIONS = `
You have access to a Notion MCP server that manages three separate workspaces. Every tool call requires a "workspace" parameter — always choose the correct one based on context.

## Workspaces

### "globalcripto"
- **What it is:** The workspace for GlobalCripto, Bruno's cryptocurrency company.
- **When to use:** Anything related to crypto business operations, company projects, team tasks, meeting notes, or company documentation.

### "personal"
- **What it is:** Bruno's personal Notion workspace.
- **When to use:** Personal notes, personal projects, personal tasks, journaling, reading lists, personal finance, or anything not related to a company.

### "nora"
- **What it is:** The workspace for Nora Finance, a fintech company. Shared with the founding partners (Jean, Luigi, Moniz, Victor).
- **When to use:** Anything related to Nora Finance — company operations, product, regulatory/legal work, partner discussions, finance tracking (Transações, Fornecedores), meeting notes, or company documentation.

## How to choose the workspace

1. Look at the user's message for explicit mentions of a workspace name or company (e.g. "GlobalCripto", "pessoal", "Nora", "Nora Finance").
2. If not explicit, infer from context:
   - GlobalCripto / crypto exchange topics → "globalcripto"
   - Nora Finance / Nora company / partners (Jean, Luigi, Moniz, Victor) topics → "nora"
   - Personal/individual topics not tied to either company → "personal"
3. If still ambiguous, ask the user which workspace they mean before making the call.

## Available tools

### Reading
- **notion_search** — Search pages and databases. Start here to find content.
- **notion_fetch** — Rich fetch: pass a URL or ID and get structured Markdown + properties + schema. Preferred over notion_get_page for understanding content.
- **notion_get_page** — Get raw page JSON and block children. Use when you need the raw API response.
- **notion_query_database** — Query a database with filters and sorts.
- **notion_get_database_schema** — Get the schema of a database. Use BEFORE querying to understand property names and types.
- **notion_list_users** — List users in a workspace.

### Writing
- **notion_create_page** — Create a new page. Accepts a "content" field with Markdown (preferred) or raw "children" blocks.
- **notion_update_page** — Update page properties (title, status, dates, etc.).
- **notion_append_blocks** — Append content to a page. Accepts Markdown via "content" or raw "children" blocks.
- **notion_update_page_content** — Search-and-replace inside a page's content. Pass old_str and new_str.
- **notion_replace_page_content** — Replace ALL content of a page. Pass Markdown via "content" or raw blocks.

### Databases
- **notion_create_database** — Create a new database with a schema inside a parent page.
- **notion_update_database** — Modify a database: add, rename, or remove columns. Also update title/description.

### Organization
- **notion_move_page** — Move a page to a different parent.
- **notion_delete_page** — Move a page to trash.

## Tips

- Always search before creating to avoid duplicates.
- Use notion_fetch to understand a page or database before modifying it.
- When querying a database for the first time, call notion_get_database_schema first so you know the property names and types for filters.
- Prefer Markdown "content" over raw "children" blocks when creating or appending — it's simpler and less error-prone.
- The user speaks Portuguese (Brazil) — respond in Portuguese unless they write in another language.
`.trim();

const app = express();

// Trust Tailscale Funnel proxy (localhost)
app.set("trust proxy", "loopback");

// Security headers
app.use(helmet());

// CORS middleware — restrict to Claude origins, only on /mcp
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
]);

const corsMiddleware: express.RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, mcp-session-id"
  );
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
};

// Rate limiting on MCP endpoint
const mcpLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
});

// Rate limiting on OAuth endpoints (stricter)
const oauthLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many OAuth requests, try again later" },
});

app.use("/mcp", corsMiddleware, mcpLimiter);
app.use("/oauth", oauthLimiter);

// Parse JSON for all routes, URL-encoded for OAuth consent form
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging
app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.socket.remoteAddress;
  const mcpMethod = req.path === "/mcp" && req.method === "POST" && req.body?.method
    ? ` [${req.body.method}]`
    : "";
  const sessionHint = req.path === "/mcp" && req.headers["mcp-session-id"]
    ? ` sid=${String(req.headers["mcp-session-id"]).slice(0, 8)}`
    : "";
  console.log(`[${timestamp}] ${req.method} ${req.path}${mcpMethod}${sessionHint} from ${ip}`);
  next();
});

// Auth middleware for /mcp — accepts static BEARER_TOKEN or OAuth access tokens
const BEARER_TOKEN = process.env.BEARER_TOKEN;

// OAuth routes (well-known, register, authorize, token, admin)
app.use(createOAuthRouter(BASE_URL, BEARER_TOKEN));

app.use("/mcp", (req, res, next) => {
  const auth = req.headers["authorization"];

  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = auth.slice(7);
  const ip = req.ip || req.socket.remoteAddress;

  // Check static bearer token first (Claude Code path). Grants full access.
  if (BEARER_TOKEN && token === BEARER_TOKEN) {
    const ctx: RequestContext = {
      authType: "bearer",
      scopes: "all",
      ip,
    };
    requestContext.run(ctx, () => next());
    return;
  }

  // Check OAuth-issued token (Claude.ai path). Scoped to selected workspaces.
  const info = getAccessTokenInfo(token);
  if (info) {
    const ctx: RequestContext = {
      authType: "oauth",
      scopes: info.scopes,
      clientId: info.client_id,
      ip,
    };
    requestContext.run(ctx, () => next());
    return;
  }

  console.warn(
    `[${new Date().toISOString()}] UNAUTHORIZED ${req.method} ${req.path} from ${ip}`
  );
  res.status(401).json({ error: "Unauthorized" });
});

if (!BEARER_TOKEN) {
  console.warn(
    "WARNING: BEARER_TOKEN not set — Claude Code direct access and the /admin/open-registration endpoint are disabled. Only OAuth tokens will work."
  );
}

// --- Session management with TTL and limits ---
const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 30 * 60_000; // 30 minutes

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, ManagedSession>();

function evictSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(id);
  session.transport.close?.();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      evictSession(id);
    }
  }
}, 60_000);

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const managed = sessions.get(sessionId)!;
    await managed.transport.handleRequest(req, res, req.body);
    return;
  }

  // Unknown session ID → tell client to re-initialize (per MCP spec).
  // Only new connections (no session ID) are allowed to create sessions.
  if (sessionId && !sessions.has(sessionId)) {
    console.warn(
      `[${new Date().toISOString()}] MCP: unknown session ${sessionId.slice(0, 8)}, sending 404 to force re-init`
    );
    res.status(404).json({ error: "Session not found or expired. Please reinitialize." });
    return;
  }

  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    )[0];
    if (oldest) evictSession(oldest[0]);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      const timer = setTimeout(() => evictSession(id), SESSION_TTL_MS);
      sessions.set(id, { transport, createdAt: Date.now(), timer });
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) evictSession(id);
  };

  const server = new McpServer(
    {
      name: "notion-mcp",
      version: "1.0.0",
    },
    {
      instructions: INSTRUCTIONS,
    }
  );

  registerTools(server);
  registerBrainSearchTool(server);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const managed = sessions.get(sessionId)!;
  await managed.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const managed = sessions.get(sessionId)!;
  await managed.transport.handleRequest(req, res);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT ?? 3456;
app.listen(PORT, () => {
  console.log(`notion-mcp listening on port ${PORT}`);
  console.log(`OAuth base URL: ${BASE_URL}`);
});
