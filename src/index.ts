import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { registerBrainSearchTool } from "./rag/brain-tool.js";
import { registerBrainIndexUrlTool } from "./rag/brain-index-url-tool.js";
import { registerBrainIndexWebTool } from "./rag/brain-index-web-tool.js";
import { registerRememberTool, registerRecallTool } from "./rag/remember-tool.js";
import { registerZinomTasksTools } from "./zinom-tasks-tools.js";
import { registerCalendarTools } from "./google/calendar-tool.js";
import { registerBrainStatusTool, setReindexInFlightSet } from "./rag/brain-status-tool.js";
import { registerBrainReindexTool, setReindexSet } from "./rag/brain-reindex-tool.js";
import { registerBrainTodayTool } from "./rag/brain-today-tool.js";
import { registerBrainListDocumentsTool } from "./rag/brain-list-documents-tool.js";
import { registerBrainFeedbackTool } from "./rag/brain-feedback-tool.js";
import { createOAuthRouter, getAccessTokenInfo } from "./oauth.js";
import { createGoogleRouter } from "./google/routes.js";
import { createNotionOnboardRouter } from "./notion-routes.js";
import { createPortalRouter } from "./portal/routes.js";
import { createAdminRouter } from "./admin/routes.js";
import { startHealthCollector, registerProbe } from "./health/collector.js";
import { vpsProbe, pm2Probe, postgresProbe } from "./health/probes-local.js";
import { makeExternalProbes } from "./health/probes-external.js";
import { anthropicBudgetCheck, voyageBudgetCheck, llmTokensCheck } from "./health/budgets.js";
import { createStripeWebhookRouter } from "./billing/webhook.js";
import { resolveBearer, accountWorkspaces } from "./account-bearer.js";
import { isAccountActive } from "./account-status.js";
import { requestContext, getContext, getAccountId, type RequestContext } from "./context.js";
import { isOwnerContext, isOperatorToken, OWNER_INSTRUCTIONS, FRIEND_INSTRUCTIONS } from "./mcp-account-config.js";
import { ALL_WORKSPACES } from "./clients.js";
import { getStatus } from "./rag/storage.js";
import { summarizeStatus, renderStatusHtml, escapeHtml } from "./rag/status.js";

const BASE_URL = process.env.BASE_URL ?? "https://vps-1200754.tail30b723.ts.net";

const app = express();

// Trust Tailscale Funnel proxy (localhost)
// SECURITY (pentest F-4): confirm Cloudflare path before trusting proxy
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
// F3.2: throttle the public onboarding endpoints (unauthenticated) — same strict
// budget as /oauth. Prevents flooding /notion/connect (state-map growth + 302s).
app.use("/notion", oauthLimiter);

// Fase 3 billing — Stripe webhook MUST be mounted before express.json() so its
// per-route express.raw() sees the exact bytes for signature verification.
app.use(createStripeWebhookRouter());

// Parse JSON for all routes, URL-encoded for OAuth consent form.
// SECURITY (pentest F-7): explicit 32 KB body limit prevents large-payload DoS.
app.use(express.json({ limit: "32kb" }));
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

// Google OAuth + status — for connecting calendar.readonly to the indexer
app.use(createGoogleRouter());

// 001-account-portal — friend self-service portal API (/portal/*) + static front.
// CORS for the Cloudflare Pages origin when configured (same-origin needs none).
// Stricter rate limit on the two public POSTs (anti-enumeration / abuse).
const PORTAL_PAGES_ORIGIN = process.env.PORTAL_PAGES_ORIGIN;
if (PORTAL_PAGES_ORIGIN) {
  app.use("/portal", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === PORTAL_PAGES_ORIGIN) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
}
const portalPublicLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Key on the target email, not the IP: behind the Tailscale funnel every
  // request arrives from loopback, so an IP key would bucket all callers into one
  // global window. Per-email caps magic-link spam at a single address; the
  // anti-enumeration property comes from the constant-time responses (the email
  // send is fire-and-forget), not from this limiter.
  keyGenerator: (req) =>
    typeof req.body?.email === "string" && req.body.email.trim()
      ? req.body.email.trim().toLowerCase()
      : "anon",
  validate: { keyGeneratorIpFallback: false },
  message: { error: "Too many requests, try again later" },
});
app.use(["/portal/register", "/portal/login", "/portal/request-invite"], portalPublicLimiter);
app.use(createPortalRouter());

// Operator admin dashboard (/admin) — bearer-gated, read-only. Mounted before the
// static front so /admin isn't shadowed by a static file.
app.use(createAdminRouter(BEARER_TOKEN));

// Static portal front — replaces the old onboarding landing (FR-012). Served at
// the site root: /, /app.html, /styles.css, /auth.js, /app.js resolve here.
const PORTAL_STATIC = join(dirname(fileURLToPath(import.meta.url)), "../portal");
app.use(express.static(PORTAL_STATIC));

// F3.2 — Notion public-integration onboarding (/notion/connect, /notion/callback).
// Additive: no-op (503) unless NOTION_OAUTH_CLIENT_ID/SECRET are set.
app.use(createNotionOnboardRouter());

app.use("/mcp", async (req, res, next) => {
  const auth = req.headers["authorization"];

  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = auth.slice(7);
  const ip = req.ip || req.socket.remoteAddress;

  // Objective #6 — suspension enforcement (fail-closed). Every token path that
  // resolves to an accountId runs through this AFTER the tenant is resolved: a
  // blocked (account.status != 'active') OR missing account is rejected with 403,
  // so setting status='suspended' actually cuts off access. Returns true (request
  // already denied) when the caller should stop. The static operator BEARER_TOKEN
  // never reaches here (no accountId, full owner access). On a DB error we DENY
  // (never fail open): isAccountActive throws, we 403 in the catch.
  const denyIfNotActive = async (accountId: string): Promise<boolean> => {
    let active: boolean;
    try {
      active = await isAccountActive(accountId);
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] status-check failed for ${accountId} from ${ip}: ${(err as Error).message}`,
      );
      res.status(403).json({ error: "Account access check failed" });
      return true;
    }
    if (!active) {
      console.warn(
        `[${new Date().toISOString()}] BLOCKED ${req.method} ${req.path} — account ${accountId} suspended (from ${ip})`,
      );
      res.status(403).json({ error: "Account suspended" });
      return true;
    }
    return false;
  };

  // Check static bearer token first (Claude Code path). Grants full access.
  if (BEARER_TOKEN && token === BEARER_TOKEN) {
    const ctx: RequestContext = {
      authType: "bearer",
      scopes: "all",
      ip,
      tokenLabel: "Claude Code", // 002-app-v2: ai_search_log client
    };
    requestContext.run(ctx, () => next());
    return;
  }

  // Check OAuth-issued token (Claude.ai path). Operator tokens are scoped to the
  // chosen workspaces; FRIEND tokens (001-account-portal) carry an accountId, so
  // we pin ctx.accountId → brain_search is scoped to that friend's account (same
  // isolation as the per-account bearer), with their workspaces as the 2nd guard.
  const info = getAccessTokenInfo(token);
  if (info) {
    let ctx: RequestContext;
    if (info.accountId) {
      // Suspension guard (fail-closed) before granting the friend any scope.
      if (await denyIfNotActive(info.accountId)) return;
      // Friend token: resolve workspaces fresh so sources added after issuance show.
      const ws = await accountWorkspaces(info.accountId);
      ctx = {
        authType: "oauth",
        scopes: ws as unknown as RequestContext["scopes"],
        accountId: info.accountId,
        ip,
        tokenLabel: "Claude.ai", // 002-app-v2: ai_search_log client
      };
    } else {
      // No accountId: operator OR a legacy/ambiguous token. Owner is decided by a
      // POSITIVE operator signal (never the absence of accountId), so a friend
      // token that lost its accountId cannot inherit the owner tool set.
      ctx = {
        authType: "oauth",
        scopes: info.scopes,
        clientId: info.client_id,
        ip,
        isOperator: isOperatorToken(info, ALL_WORKSPACES),
        tokenLabel: "Claude.ai", // 002-app-v2: ai_search_log client
      };
    }
    requestContext.run(ctx, () => next());
    return;
  }

  // F3.2c — per-account bearer (onboarded users querying their OWN brain). The
  // token maps to an account; we pin ctx.accountId so brain_search is scoped to
  // that account (account_id guard) and its workspaces (workspace guard).
  const acct = await resolveBearer(token);
  if (acct) {
    // Suspension guard (fail-closed) before granting the per-account bearer scope.
    if (await denyIfNotActive(acct.accountId)) return;
    const ctx: RequestContext = {
      authType: "bearer",
      scopes: acct.workspaces as unknown as RequestContext["scopes"],
      accountId: acct.accountId,
      ip,
      // 002-app-v2: ai_search_log client — the label given at issue time, or a
      // generic "Assistente" for unlabeled tokens.
      tokenLabel: acct.label ?? "Assistente",
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
  /** WS2 — the account that created this session. A session is bound to one
   *  account: its McpServer was built with that account's instructions + tool set
   *  (owner gets notion_*; a friend does not). Reuse by a DIFFERENT account is
   *  rejected, so a friend can never inherit the owner's tools via a leaked
   *  mcp-session-id (confused-deputy / session fixation). */
  accountId: string;
}

const sessions = new Map<string, ManagedSession>();

// --- Shared reindex in-flight set (brain_reindex + brain_status + portal /reindex) ---
// NOTE: the portal /portal/reindex route has its OWN local reindexInFlight Set inside
// createPortalRouter(). That set guards portal-initiated reindexes; this one guards
// MCP-initiated ones. Both share the same account-dedup semantics: at most one
// concurrent reindex per accountId regardless of which surface triggered it.
// If a future migration wants a single shared set, move it to a shared module and
// import it here + in portal/routes.ts.
const mcpReindexInFlight = new Set<string>();
setReindexInFlightSet(mcpReindexInFlight);
setReindexSet(mcpReindexInFlight);

/** Serve an existing session ONLY to the account that created it. Returns the
 *  session when the current request's account matches; otherwise responds 404
 *  (forcing the client to re-initialize a session bound to its own account) and
 *  returns null. */
function sessionForRequest(sessionId: string, res: express.Response): ManagedSession | null {
  const managed = sessions.get(sessionId);
  if (!managed) return null;
  if (managed.accountId !== getAccountId()) {
    console.warn(
      `[${new Date().toISOString()}] MCP: session ${sessionId.slice(0, 8)} account mismatch (bound=${managed.accountId}, req=${getAccountId()}); rejecting`
    );
    res.status(404).json({ error: "Session not found or expired. Please reinitialize." });
    return null;
  }
  return managed;
}

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
    const managed = sessionForRequest(sessionId, res); // account-bound; 404 on mismatch
    if (!managed) return;
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

  // WS2 — tailor the server to the account. This runs inside the auth
  // middleware's requestContext scope, so getContext()/getAccountId() carry the
  // resolved account. Owner gets the full INSTRUCTIONS + all notion_* tools; a
  // friend gets friend INSTRUCTIONS + a SAFE tool set (search, web-index,
  // create-task) — the 24 notion_* tools are owner-only because they assume
  // Bruno's fixed workspaces and expose destructive ops not meant for friends.
  // The session is BOUND to this account (sessionAccountId) so a later request
  // from a different account can never reuse it and inherit this tool set.
  const owner = isOwnerContext(getContext());
  const sessionAccountId = getAccountId();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      const timer = setTimeout(() => evictSession(id), SESSION_TTL_MS);
      sessions.set(id, { transport, createdAt: Date.now(), timer, accountId: sessionAccountId });
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) evictSession(id);
  };

  const server = new McpServer(
    {
      name: "zinom",
      version: "1.0.0",
    },
    {
      instructions: owner ? OWNER_INSTRUCTIONS : FRIEND_INSTRUCTIONS,
    }
  );

  if (owner) {
    registerTools(server);
    registerBrainSearchTool(server);
    await registerBrainIndexUrlTool(server);
    registerBrainIndexWebTool(server);
    registerRememberTool(server);
    registerRecallTool(server);
    registerZinomTasksTools(server); // 003-tasks-v1: tasks also on the owner surface
    registerCalendarTools(server);
    registerBrainStatusTool(server);
    registerBrainReindexTool(server);
    registerBrainTodayTool(server);
    registerBrainListDocumentsTool(server);
    registerBrainFeedbackTool(server);
  } else {
    registerBrainSearchTool(server);
    await registerBrainIndexUrlTool(server);
    registerBrainIndexWebTool(server);
    registerRememberTool(server);
    registerRecallTool(server);
    registerZinomTasksTools(server);
    registerCalendarTools(server);
    registerBrainStatusTool(server);
    registerBrainReindexTool(server);
    registerBrainTodayTool(server);
    registerBrainListDocumentsTool(server);
    registerBrainFeedbackTool(server);
  }
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const managed = sessionForRequest(sessionId, res); // account-bound; 404 on mismatch
  if (!managed) return;
  await managed.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const managed = sessionForRequest(sessionId, res); // account-bound; 404 on mismatch
  if (!managed) return;
  await managed.transport.handleRequest(req, res);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Bearer-protected observability: latest run per source + staleness, so a dead
// or 0-indexing source is never silent. Not public (auth like /mcp's bearer path).
// F2.5: content-negotiates — `?format=html` or an Accept: text/html browser gets
// the mini-dashboard; everything else gets JSON. The bearer token may come from
// the Authorization header OR a `?token=` query param (so the dashboard opens in
// a browser over Tailscale — req.path logging excludes the query string).
app.get("/status", async (req, res) => {
  const auth = req.headers["authorization"];
  const headerToken = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  const token = headerToken ?? queryToken;
  const wantsHtml =
    req.query.format === "html" ||
    (!req.query.format && (req.headers.accept ?? "").includes("text/html"));

  if (!BEARER_TOKEN || token !== BEARER_TOKEN) {
    if (wantsHtml) {
      res.status(401).type("html").send("<!doctype html><meta charset=utf-8><p>401 — informe ?token=&lt;BEARER_TOKEN&gt;</p>");
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
    return;
  }
  try {
    const now = new Date().toISOString();
    const sources = summarizeStatus(await getStatus());
    if (wantsHtml) {
      res.type("html").send(renderStatusHtml(now, sources));
      return;
    }
    res.json({
      now,
      stale_or_failing: sources.filter((s) => !s.ok || s.stale).map((s) => s.source),
      sources,
    });
  } catch (err: any) {
    if (wantsHtml) {
      res.status(500).type("html").send(`<!doctype html><meta charset=utf-8><p>500 — ${escapeHtml(err?.message ?? "status query failed")}</p>`);
    } else {
      res.status(500).json({ error: err?.message ?? "status query failed" });
    }
  }
});

const PORT = process.env.PORT ?? 3456;
const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";
app.listen(Number(PORT), BIND_HOST, () => {
  console.log(`notion-mcp listening on ${BIND_HOST}:${PORT}`);
  console.log(`OAuth base URL: ${BASE_URL}`);
});

// Painel de saúde (admin → Sistema): coleta periódica de amostras em
// health_samples. Precisa do Postgres; sem POSTGRES_URL (ex.: dev portal-only)
// o collector simplesmente não sobe.
if (process.env.POSTGRES_URL) {
  const healthProbes = [
    vpsProbe,
    pm2Probe,
    postgresProbe,
    ...makeExternalProbes(),
    anthropicBudgetCheck,
    voyageBudgetCheck,
    llmTokensCheck,
  ];
  for (const p of healthProbes) registerProbe(p);
  startHealthCollector();
}
