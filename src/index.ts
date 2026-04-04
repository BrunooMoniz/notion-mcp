import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { createOAuthRouter, isValidAccessToken } from "./oauth.js";

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
- **What it is:** The workspace for Nora, Bruno's daughter.
- **When to use:** Anything related to Nora — school, activities, health records, routines, wishlists, or parenting notes.

## How to choose the workspace

1. Look at the user's message for explicit mentions of a workspace name, company, or person (e.g. "GlobalCripto", "pessoal", "Nora").
2. If not explicit, infer from context:
   - Work/crypto/company topics → "globalcripto"
   - Personal/individual topics → "personal"
   - Child/daughter/school/parenting topics → "nora"
3. If still ambiguous, ask the user which workspace they mean before making the call.

## Available tools

- **notion_search** — Search pages and databases. Start here to find content.
- **notion_get_page** — Get a page and its content blocks. Use after search to read details.
- **notion_query_database** — Query a database with filters and sorts. Use when working with structured data (tables, boards, etc.).
- **notion_get_database_schema** — Get the schema of a database. Use this BEFORE querying a database to understand its properties and build correct filters.
- **notion_create_page** — Create a new page (inside a database or as a sub-page).
- **notion_update_page** — Update properties of an existing page.
- **notion_append_blocks** — Append content blocks to a page. Use for adding text, headings, lists, etc.
- **notion_list_users** — List users in a workspace.

## Tips

- Always search before creating to avoid duplicates.
- When querying a database for the first time, call notion_get_database_schema first so you know the property names and types for filters.
- The user speaks Portuguese (Brazil) — respond in Portuguese unless they write in another language.
`.trim();

const app = express();

// Trust Tailscale Funnel proxy (localhost)
app.set("trust proxy", "loopback");

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // MCP uses JSON/SSE, CSP not needed
  })
);

// CORS middleware — restrict to Claude origins
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://www.claude.ai",
]);

app.use((req, res, next) => {
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
});

// Rate limiting on MCP endpoint
app.use(
  "/mcp",
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, try again later" },
  })
);

// Parse JSON for all routes, URL-encoded for OAuth consent form
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging
app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  const ip = req.ip || req.socket.remoteAddress;
  console.log(`[${timestamp}] ${req.method} ${req.path} from ${ip}`);
  next();
});

// OAuth routes (well-known, register, authorize, token)
app.use(createOAuthRouter(BASE_URL));

// Auth middleware for /mcp — accepts static BEARER_TOKEN or OAuth access tokens
const BEARER_TOKEN = process.env.BEARER_TOKEN;

app.use("/mcp", (req, res, next) => {
  const auth = req.headers["authorization"];

  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = auth.slice(7);

  // Check static token
  if (BEARER_TOKEN && token === BEARER_TOKEN) {
    next();
    return;
  }

  // Check OAuth-issued token
  if (isValidAccessToken(token)) {
    next();
    return;
  }

  const ip = req.ip || req.socket.remoteAddress;
  console.warn(
    `[${new Date().toISOString()}] UNAUTHORIZED ${req.method} ${req.path} from ${ip}`
  );
  res.status(401).json({ error: "Unauthorized" });
});

if (!BEARER_TOKEN) {
  console.warn("WARNING: BEARER_TOKEN not set — only OAuth tokens will work.");
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
  if (session) {
    clearTimeout(session.timer);
    session.transport.close?.();
    sessions.delete(id);
  }
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
