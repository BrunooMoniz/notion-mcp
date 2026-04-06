import { Router } from "express";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";
import { ALL_WORKSPACES, type Workspace } from "./clients.js";

// --- Helpers ---

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sha256base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:" && parsed.hostname === "localhost") return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeWorkspaces(input: unknown): Workspace[] {
  const arr = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [input]
      : [];
  const result: Workspace[] = [];
  for (const candidate of arr) {
    if (typeof candidate !== "string") continue;
    if ((ALL_WORKSPACES as string[]).includes(candidate)) {
      result.push(candidate as Workspace);
    }
  }
  return result;
}

// --- Password verification (scrypt) ---

const _hashEnv = process.env.OAUTH_PASSWORD_HASH;
if (!_hashEnv) {
  console.error(
    "FATAL: OAUTH_PASSWORD_HASH environment variable is required.\n" +
      "Generate one with: node scripts/hash-password.mjs '<your-password>'"
  );
  process.exit(1);
}
const [_saltHex, _hashHex] = _hashEnv.split(":");
if (!_saltHex || !_hashHex) {
  console.error(
    "FATAL: OAUTH_PASSWORD_HASH must be in format 'salt-hex:hash-hex'.\n" +
      "Regenerate with: node scripts/hash-password.mjs '<your-password>'"
  );
  process.exit(1);
}
const STORED_SALT = Buffer.from(_saltHex, "hex");
const STORED_HASH = Buffer.from(_hashHex, "hex");
if (STORED_SALT.length !== 16 || STORED_HASH.length !== 64) {
  console.error("FATAL: OAUTH_PASSWORD_HASH has invalid lengths (expect 16-byte salt, 64-byte hash).");
  process.exit(1);
}

function verifyPassword(candidate: string): boolean {
  try {
    const derived = scryptSync(candidate, STORED_SALT, 64);
    return timingSafeEqual(derived, STORED_HASH);
  } catch {
    return false;
  }
}

// --- In-memory stores ---

interface RegisteredClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}

interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: Workspace[];
  expires_at: number;
}

export interface AccessToken {
  token: string;
  client_id: string;
  scopes: Workspace[];
  expires_at: number;
}

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();
const csrfTokens = new Map<string, number>(); // token -> expires_at

const CODE_TTL_MS = 5 * 60_000; // 5 minutes
const TOKEN_TTL_MS = 24 * 60 * 60_000; // 24 hours
const CSRF_TTL_MS = 5 * 60_000; // 5 minutes

// --- Registration enrollment window ---
// /oauth/register is only open while this timestamp is in the future.
// Opened by POST /admin/open-registration (gated by BEARER_TOKEN).
const ENROLLMENT_WINDOW_MS = 10 * 60_000; // 10 minutes
let registrationWindowUntil = 0;

export function isRegistrationOpen(): boolean {
  return Date.now() < registrationWindowUntil;
}

// --- Brute-force protection ---
const failedAttempts = new Map<string, { count: number; blockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 5 * 60_000; // 5 minutes

function isBlocked(ip: string): boolean {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.blockedUntil) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  const entry = failedAttempts.get(ip) ?? { count: 0, blockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = Date.now() + BLOCK_DURATION_MS;
  }
  failedAttempts.set(ip, entry);
}

function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip);
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) {
    if (now > v.expires_at) authCodes.delete(k);
  }
  for (const [k, v] of accessTokens) {
    if (now > v.expires_at) accessTokens.delete(k);
  }
  for (const [k, v] of csrfTokens) {
    if (now > v) csrfTokens.delete(k);
  }
  for (const [k, v] of failedAttempts) {
    if (now > v.blockedUntil && v.count < MAX_ATTEMPTS) failedAttempts.delete(k);
  }
}, 60_000);

// --- Token lookup ---

export function getAccessTokenInfo(token: string): AccessToken | null {
  const entry = accessTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expires_at) {
    accessTokens.delete(token);
    return null;
  }
  return entry;
}

export function isValidAccessToken(token: string): boolean {
  return getAccessTokenInfo(token) !== null;
}

// --- Router ---

export function createOAuthRouter(baseUrl: string, bearerToken?: string): Router {
  const router = Router();

  // Admin: open the registration enrollment window.
  // Gated by BEARER_TOKEN so only the server operator can call it.
  router.post("/admin/open-registration", (req, res) => {
    if (!bearerToken) {
      res.status(503).json({
        error: "unavailable",
        error_description: "BEARER_TOKEN not configured; admin endpoint disabled",
      });
      return;
    }
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), bearerToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    registrationWindowUntil = Date.now() + ENROLLMENT_WINDOW_MS;
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    console.log(
      `[${new Date().toISOString()}] OAuth: registration window opened until ${new Date(registrationWindowUntil).toISOString()} by ${ip}`
    );
    res.json({
      open_until: new Date(registrationWindowUntil).toISOString(),
      ttl_seconds: ENROLLMENT_WINDOW_MS / 1000,
    });
  });

  router.post("/admin/close-registration", (req, res) => {
    if (!bearerToken) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), bearerToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    registrationWindowUntil = 0;
    console.log(`[${new Date().toISOString()}] OAuth: registration window closed manually`);
    res.json({ ok: true });
  });

  // RFC 9728 — Protected Resource Metadata
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414 — Authorization Server Metadata
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "none",
      ],
      code_challenge_methods_supported: ["S256"],
    });
  });

  // Dynamic Client Registration (RFC 7591) — only open during enrollment window
  router.post("/oauth/register", (req, res) => {
    if (!isRegistrationOpen()) {
      res.status(403).json({
        error: "registration_closed",
        error_description:
          "Dynamic registration is closed. Admin must open the window first.",
      });
      return;
    }

    const { redirect_uris, client_name } = req.body;

    if (
      !redirect_uris ||
      !Array.isArray(redirect_uris) ||
      redirect_uris.length === 0
    ) {
      res.status(400).json({ error: "invalid_client_metadata" });
      return;
    }

    // Validate redirect URIs
    for (const uri of redirect_uris) {
      if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
        res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `Invalid redirect URI: ${typeof uri === "string" ? uri : "(non-string)"}. Only https:// or http://localhost allowed.`,
        });
        return;
      }
    }

    const client_id = randomUUID();
    const client_secret = generateToken();

    const client: RegisteredClient = {
      client_id,
      client_secret,
      redirect_uris,
      client_name: typeof client_name === "string" ? client_name.slice(0, 200) : undefined,
      created_at: Date.now(),
    };

    clients.set(client_id, client);
    console.log(
      `[${new Date().toISOString()}] OAuth: registered client "${client.client_name}" (${client_id})`
    );

    res.status(201).json({
      client_id,
      client_secret,
      redirect_uris,
      client_name: client.client_name,
    });
  });

  // Authorization endpoint — render consent page
  router.get("/oauth/authorize", (req, res) => {
    const {
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
    } = req.query as Record<string, string>;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }

    if (!client_id || !clients.has(client_id)) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    if (!code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "PKCE S256 required" });
      return;
    }

    const client = clients.get(client_id)!;
    if (!client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }

    // Generate CSRF token
    const csrf = generateToken();
    csrfTokens.set(csrf, Date.now() + CSRF_TTL_MS);

    const workspaceCheckboxes = ALL_WORKSPACES.map((ws) => {
      const defaultChecked = ws !== "nora"; // Nora requires explicit opt-in
      return `      <label class="scope">
        <input type="checkbox" name="scope" value="${ws}" ${defaultChecked ? "checked" : ""}>
        <span>${ws}</span>
      </label>`;
    }).join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notion MCP - Authorize</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; color: #e0e0e0;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #16213e; border-radius: 12px; padding: 40px;
      max-width: 460px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { font-size: 1.4em; margin-bottom: 8px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 24px; font-size: 0.9em; }
    .client-name { color: #64b5f6; font-weight: 600; }
    .permissions { background: #0f3460; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .permissions li { margin: 8px 0; font-size: 0.9em; list-style: none; }
    .section-title { color: #aaa; font-size: 0.85em; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .scopes { background: #0f3460; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
    label.scope {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 0; font-size: 0.95em; cursor: pointer;
    }
    label.scope input { width: 16px; height: 16px; cursor: pointer; }
    label.scope span { color: #e0e0e0; font-family: ui-monospace, monospace; }
    label { display: block; margin-bottom: 8px; font-size: 0.9em; color: #aaa; }
    input[type="password"] {
      width: 100%; padding: 10px 14px; border-radius: 8px;
      border: 1px solid #333; background: #1a1a2e; color: #fff;
      font-size: 1em; margin-bottom: 16px;
    }
    .buttons { display: flex; gap: 12px; margin-top: 8px; }
    button {
      flex: 1; padding: 12px; border-radius: 8px; border: none;
      font-size: 1em; cursor: pointer; font-weight: 600;
    }
    .approve { background: #4caf50; color: #fff; }
    .approve:hover { background: #43a047; }
    .deny { background: #333; color: #ccc; }
    .deny:hover { background: #444; }
    .error { color: #ef5350; font-size: 0.85em; margin-top: 8px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p class="subtitle">
      <span class="client-name">${escapeHtml(client.client_name || client_id)}</span>
      wants to access your Notion MCP server.
    </p>
    <ul class="permissions">
      <li>Search pages and databases</li>
      <li>Read and create pages</li>
      <li>Update pages and append content</li>
      <li>Query databases</li>
    </ul>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">
      <input type="hidden" name="state" value="${escapeHtml(state || "")}">
      <input type="hidden" name="_csrf" value="${csrf}">
      <div class="section-title">Workspaces this session may access</div>
      <div class="scopes">
${workspaceCheckboxes}
      </div>
      <label for="password">Enter your admin password to authorize:</label>
      <input type="password" id="password" name="password" required placeholder="Password">
      <p class="error" id="error-msg">Invalid password</p>
      <div class="buttons">
        <button type="button" class="deny" onclick="window.close()">Deny</button>
        <button type="submit" class="approve">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`;

    res
      .header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'")
      .type("html")
      .send(html);
  });

  // Authorization POST (consent form submission)
  router.post("/oauth/authorize", (req, res) => {
    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      password,
      _csrf,
      scope,
    } = req.body;

    const ip = req.ip || req.socket.remoteAddress || "unknown";

    // Brute-force check
    if (isBlocked(ip)) {
      console.warn(
        `[${new Date().toISOString()}] OAuth: blocked login attempt from ${ip} (too many failures)`
      );
      res.status(429).type("html").send(`<!DOCTYPE html>
<html><head><title>Blocked</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#ef5350;}</style>
</head><body><h2>Too many failed attempts. Try again in 5 minutes.</h2></body></html>`);
      return;
    }

    // CSRF validation
    if (!_csrf || !csrfTokens.has(_csrf)) {
      res.status(403).json({ error: "invalid_csrf_token" });
      return;
    }
    csrfTokens.delete(_csrf);

    // Verify admin password (scrypt, timing-safe)
    if (!password || typeof password !== "string" || !verifyPassword(password)) {
      recordFailedAttempt(ip);
      console.warn(
        `[${new Date().toISOString()}] OAuth: failed password attempt from ${ip}`
      );
      res.status(403).type("html").send(`<!DOCTYPE html>
<html><head><title>Error</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#ef5350;}</style>
</head><body><h2>Invalid password. Close this tab and try again.</h2></body></html>`);
      return;
    }

    clearFailedAttempts(ip);

    if (!client_id || !clients.has(client_id)) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    // Defense in depth: revalidate redirect_uri against the registered client.
    // The GET handler already did this, but a hand-crafted POST could bypass it.
    const client = clients.get(client_id)!;
    if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }

    // Parse and validate scopes. Reject if user unchecked everything.
    const scopes = normalizeWorkspaces(scope);
    if (scopes.length === 0) {
      res.status(400).type("html").send(`<!DOCTYPE html>
<html><head><title>No scope selected</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#ef5350;}</style>
</head><body><h2>Select at least one workspace to authorize.</h2></body></html>`);
      return;
    }

    const code = generateToken();
    authCodes.set(code, {
      code,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scopes,
      expires_at: Date.now() + CODE_TTL_MS,
    });

    console.log(
      `[${new Date().toISOString()}] OAuth: issued auth code for client ${client_id} from ${ip} (scopes: ${scopes.join(",")})`
    );

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // Token endpoint
  router.post("/oauth/token", (req, res) => {
    const {
      grant_type,
      code,
      redirect_uri,
      client_id,
      client_secret,
      code_verifier,
    } = req.body;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const authCode = authCodes.get(code);
    if (!authCode) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Verify code hasn't expired
    if (Date.now() > authCode.expires_at) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
      return;
    }

    // Verify client
    if (authCode.client_id !== client_id) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    // Verify client_secret for confidential clients
    const registeredClient = clients.get(client_id);
    if (registeredClient?.client_secret) {
      if (!client_secret || !safeEqual(client_secret, registeredClient.client_secret)) {
        res.status(401).json({ error: "invalid_client", error_description: "invalid client_secret" });
        return;
      }
    }

    // Verify redirect_uri
    if (authCode.redirect_uri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Verify PKCE
    if (!code_verifier) {
      res.status(400).json({ error: "invalid_request", error_description: "code_verifier required" });
      return;
    }

    const expectedChallenge = sha256base64url(code_verifier);
    if (expectedChallenge !== authCode.code_challenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    // Consume the code (one-time use)
    authCodes.delete(code);

    // Issue access token with scopes inherited from the auth code
    const token = generateToken();
    const expiresIn = TOKEN_TTL_MS / 1000;
    accessTokens.set(token, {
      token,
      client_id,
      scopes: authCode.scopes,
      expires_at: Date.now() + TOKEN_TTL_MS,
    });

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    console.log(
      `[${new Date().toISOString()}] OAuth: issued access token for client ${client_id} from ${ip} (scopes: ${authCode.scopes.join(",")})`
    );

    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: authCode.scopes.join(" "),
    });
  });

  return router;
}
