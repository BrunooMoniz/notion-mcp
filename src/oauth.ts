import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";

// --- In-memory stores ---
interface RegisteredClient {
  client_id: string;
  client_secret?: string;
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
  expires_at: number;
}

interface AccessToken {
  token: string;
  client_id: string;
  expires_at: number;
}

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();

const CODE_TTL_MS = 5 * 60_000; // 5 minutes
const TOKEN_TTL_MS = 24 * 60 * 60_000; // 24 hours

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) {
    if (now > v.expires_at) authCodes.delete(k);
  }
  for (const [k, v] of accessTokens) {
    if (now > v.expires_at) accessTokens.delete(k);
  }
}, 60_000);

// --- Helpers ---
function sha256base64url(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("base64url");
}

export function isValidAccessToken(token: string): boolean {
  const entry = accessTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expires_at) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

// --- Admin password for consent screen ---
const OAUTH_ADMIN_PASSWORD = process.env.OAUTH_PASSWORD ?? process.env.BEARER_TOKEN ?? "admin";

// --- Router ---
export function createOAuthRouter(baseUrl: string): Router {
  const router = Router();

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

  // Dynamic Client Registration (RFC 7591)
  router.post("/oauth/register", (req, res) => {
    const { redirect_uris, client_name } = req.body;

    if (
      !redirect_uris ||
      !Array.isArray(redirect_uris) ||
      redirect_uris.length === 0
    ) {
      res.status(400).json({ error: "invalid_client_metadata" });
      return;
    }

    const client_id = randomUUID();
    const client_secret = randomUUID();

    const client: RegisteredClient = {
      client_id,
      client_secret,
      redirect_uris,
      client_name,
      created_at: Date.now(),
    };

    clients.set(client_id, client);
    console.log(
      `[${new Date().toISOString()}] OAuth: registered client "${client_name}" (${client_id})`
    );

    res.status(201).json({
      client_id,
      client_secret,
      redirect_uris,
      client_name,
    });
  });

  // Authorization endpoint
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

    // Render consent page
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
      max-width: 420px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { font-size: 1.4em; margin-bottom: 8px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 24px; font-size: 0.9em; }
    .client-name { color: #64b5f6; font-weight: 600; }
    .permissions { background: #0f3460; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .permissions li { margin: 8px 0; font-size: 0.9em; }
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
      <span class="client-name">${client.client_name || client_id}</span>
      wants to access your Notion MCP server.
    </p>
    <ul class="permissions">
      <li>Search pages and databases</li>
      <li>Read and create pages</li>
      <li>Update pages and append content</li>
      <li>Query databases</li>
    </ul>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${client_id}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="code_challenge" value="${code_challenge}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method}">
      <input type="hidden" name="state" value="${state || ""}">
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

    res.type("html").send(html);
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
    } = req.body;

    // Verify admin password
    if (password !== OAUTH_ADMIN_PASSWORD) {
      res.status(403).type("html").send(`<!DOCTYPE html>
<html><head><title>Error</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#ef5350;}</style>
</head><body><h2>Invalid password. Close this tab and try again.</h2></body></html>`);
      return;
    }

    if (!client_id || !clients.has(client_id)) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    const code = randomUUID();
    authCodes.set(code, {
      code,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      expires_at: Date.now() + CODE_TTL_MS,
    });

    console.log(
      `[${new Date().toISOString()}] OAuth: issued auth code for client ${client_id}`
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

    // Issue access token
    const token = randomUUID();
    const expiresIn = TOKEN_TTL_MS / 1000;
    accessTokens.set(token, {
      token,
      client_id,
      expires_at: Date.now() + TOKEN_TTL_MS,
    });

    console.log(
      `[${new Date().toISOString()}] OAuth: issued access token for client ${client_id}`
    );

    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
    });
  });

  return router;
}
