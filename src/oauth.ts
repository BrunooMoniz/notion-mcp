import { Router } from "express";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";
import { safeEqual } from "./crypto-utils.js";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_WORKSPACES, type Workspace } from "./clients.js";
import {
  isTokenExpired,
  isRevoked as isRevokedPure,
  validateRefreshToken as validateRefreshTokenPure,
  type TokenStore as PureTokenStore,
} from "./oauth-tokens.js";
import { getPool } from "./rag/storage.js";
import { resolveSession, SESSION_COOKIE } from "./portal/session.js";
import { findAccountByEmail, getAccountEmail, normalizeEmail, isLikelyEmail } from "./portal/accounts.js";
import { issueLoginCode, consumeLoginCode } from "./portal/magic-link.js";
import { sendLoginCodeEmail } from "./portal/email.js";
import {
  isRegistrationOpen,
  openRegistrationWindow,
  closeRegistrationWindow,
} from "./oauth-registration-window.js";

// Re-export so existing importers of `isRegistrationOpen` from this module keep
// working; the state now lives in oauth-registration-window.ts (portal-shareable).
export { isRegistrationOpen };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STORE_PATH = join(DATA_DIR, "oauth-store.json");

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

// safeEqual is imported from crypto-utils.ts and re-exported for callers that
// already import it from this module (backward-compatible).
export { safeEqual };

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
  accountId?: string; // 001-account-portal: set for the friend (per-account) flow
  kind?: "operator"; // operator (admin-password) flow → owner tools/instructions at /mcp
}

export interface AccessToken {
  token: string;
  client_id: string;
  scopes: Workspace[];
  expires_at: number;
  accountId?: string; // friend flow → /mcp scopes to this account
  kind?: "operator"; // operator (admin-password) flow → owner tools/instructions at /mcp
}

export interface RefreshToken {
  token: string;
  client_id: string;
  scopes: Workspace[];
  expires_at: number;
  accountId?: string;
  kind?: "operator"; // operator (admin-password) flow → owner tools/instructions at /mcp
}

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();
const refreshTokens = new Map<string, RefreshToken>();
// Revoked access AND refresh token strings. Persisted so revocation survives
// restarts. getAccessTokenInfo and the refresh grant both consult this.
const revokedTokens = new Set<string>();
const csrfTokens = new Map<string, number>(); // token -> expires_at

// Build the plain TokenStore snapshot the pure helpers operate on. Cheap to
// construct per-call (small maps); keeps oauth.ts the single source of truth
// for state while reusing the unit-tested logic in oauth-tokens.ts.
function snapshotStore(): PureTokenStore {
  return {
    accessTokens: [...accessTokens.values()],
    refreshTokens: [...refreshTokens.values()],
    revoked: revokedTokens,
  };
}

// --- Persistence ---

function loadStore(): void {
  try {
    const raw = readFileSync(STORE_PATH, "utf8");
    // Backward compatible: refreshTokens/revoked are optional. An older store
    // (clients + accessTokens only) loads cleanly with empty refresh/revoked.
    const data = JSON.parse(raw) as {
      clients?: RegisteredClient[];
      accessTokens?: AccessToken[];
      refreshTokens?: RefreshToken[];
      revoked?: string[];
    };
    const now = Date.now();
    for (const c of data.clients ?? []) clients.set(c.client_id, c);
    // EXISTING access tokens keep their stored expiry — read them as-is, only
    // dropping ones already past their persisted expiry. We do NOT retroactively
    // shorten any TTL.
    for (const t of data.accessTokens ?? []) {
      if (t.expires_at > now) accessTokens.set(t.token, t);
    }
    for (const t of data.refreshTokens ?? []) {
      if (t.expires_at > now) refreshTokens.set(t.token, t);
    }
    for (const tok of data.revoked ?? []) revokedTokens.add(tok);
    console.log(
      `[oauth] Loaded ${clients.size} clients, ${accessTokens.size} access tokens, ${refreshTokens.size} refresh tokens, ${revokedTokens.size} revoked from disk.`
    );
  } catch {
    // First run or missing file — start fresh.
  }
}

function saveStore(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      clients: [...clients.values()],
      accessTokens: [...accessTokens.values()],
      refreshTokens: [...refreshTokens.values()],
      revoked: [...revokedTokens],
    };
    // oauth-store.json holds bearer secrets (client secrets + live tokens):
    // restrict to owner read/write. mode on writeFileSync is masked by umask on
    // create, so chmod afterward to be certain.
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(STORE_PATH, 0o600);
    } catch {
      // chmod best-effort (e.g. non-POSIX fs); the write already used mode 0o600.
    }
  } catch (err) {
    console.error("[oauth] Failed to persist store:", err);
  }
}

loadStore();

const CODE_TTL_MS = 5 * 60_000; // 5 minutes
const CSRF_TTL_MS = 5 * 60_000; // 5 minutes

// Configurable, shorter TTL for NEWLY-issued access tokens. Default 24h.
// EXISTING persisted access tokens keep their stored expiry (loadStore reads
// them as-is); only freshly-minted tokens use this.
const ACCESS_TTL_MS = parseInt(process.env.OAUTH_ACCESS_TTL_HOURS ?? "24", 10) * 60 * 60_000;
// Refresh-token TTL. Default 90 days.
const REFRESH_TTL_MS = parseInt(process.env.OAUTH_REFRESH_TTL_DAYS ?? "90", 10) * 24 * 60 * 60_000;

// --- Registration enrollment window ---
// /oauth/register is only open while this timestamp is in the future.
// Opened by POST /admin/open-registration (gated by BEARER_TOKEN).
// Set ENROLLMENT_WINDOW_MS env var to override (in minutes).
const ENROLLMENT_WINDOW_MS = parseInt(process.env.ENROLLMENT_WINDOW_MINUTES ?? "60") * 60_000;

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
  let tokensPruned = false;
  for (const [k, v] of accessTokens) {
    if (now > v.expires_at) { accessTokens.delete(k); tokensPruned = true; }
  }
  for (const [k, v] of refreshTokens) {
    if (now > v.expires_at) { refreshTokens.delete(k); tokensPruned = true; }
  }
  for (const [k, v] of csrfTokens) {
    if (now > v) csrfTokens.delete(k);
  }
  for (const [k, v] of failedAttempts) {
    if (now > v.blockedUntil && v.count < MAX_ATTEMPTS) failedAttempts.delete(k);
  }
  if (tokensPruned) saveStore();
}, 60_000);

// --- 001-account-portal: friend (per-account) OAuth helpers ---

interface OAuthParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
}

function readCookie(req: { headers: Record<string, unknown> }, name: string): string | null {
  const header = req.headers?.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function friendWorkspaces(accountId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ workspace: string }>(
    `SELECT workspace FROM account_workspaces WHERE account_id=$1`,
    [accountId],
  );
  return rows.map((r) => r.workspace);
}

// Short codes → limit verification attempts per email.
const codeAttempts = new Map<string, { count: number; until: number }>();
function codeBlocked(email: string): boolean {
  const e = codeAttempts.get(email);
  if (!e) return false;
  if (Date.now() > e.until) {
    codeAttempts.delete(email);
    return false;
  }
  return e.count >= 6;
}
function recordCodeFail(email: string): void {
  const e = codeAttempts.get(email) ?? { count: 0, until: 0 };
  e.count += 1;
  e.until = Date.now() + 10 * 60_000;
  codeAttempts.set(email, e);
}

// Per-email code-SEND limiter. The global /oauth IP limiter collapses to one
// bucket behind the funnel (loopback), so cap OTP issuance per email here — both
// to stop inbox-bombing a known friend and to bound Resend usage. Applied
// uniformly (account exists or not) so it never leaks account existence.
const codeIssue = new Map<string, { count: number; until: number }>();
const CODE_SEND_MAX = 4;
function issueBlocked(email: string): boolean {
  const e = codeIssue.get(email);
  if (!e) return false;
  if (Date.now() > e.until) {
    codeIssue.delete(email);
    return false;
  }
  return e.count >= CODE_SEND_MAX;
}
function recordIssue(email: string): void {
  const e = codeIssue.get(email) ?? { count: 0, until: 0 };
  if (e.count === 0) e.until = Date.now() + 10 * 60_000;
  e.count += 1;
  codeIssue.set(email, e);
}

const AUTH_CSS = `* { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
  .card { background: #16213e; border-radius: 12px; padding: 36px; max-width: 460px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
  h1 { font-size: 1.35em; margin-bottom: 8px; color: #fff; }
  .subtitle { color: #9aa; margin-bottom: 20px; font-size: 0.92em; }
  .client-name { color: #64b5f6; font-weight: 600; }
  label { display: block; margin-bottom: 6px; font-size: 0.88em; color: #aaa; }
  input[type=email], input[type=text], input[type=password] { width: 100%; padding: 11px 14px; border-radius: 8px; border: 1px solid #333; background: #1a1a2e; color: #fff; font-size: 1em; margin-bottom: 14px; }
  input[name=code] { letter-spacing: 6px; font-size: 1.4em; text-align: center; }
  button { width: 100%; padding: 12px; border-radius: 8px; border: none; font-size: 1em; cursor: pointer; font-weight: 600; background: #4caf50; color: #fff; }
  button:hover { background: #43a047; }
  .err { color: #ef5350; font-size: 0.85em; margin: 6px 0; }
  .perm { background: #0f3460; border-radius: 8px; padding: 14px 16px; margin: 14px 0; font-size: 0.88em; color: #cdd; }
  details { margin-top: 18px; border-top: 1px solid #2a3a5a; padding-top: 12px; }
  summary { cursor: pointer; color: #9aa; font-size: 0.85em; }
  .scopes { background: #0f3460; border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
  label.scope { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 0.95em; cursor: pointer; }
  label.scope span { font-family: ui-monospace, monospace; color: #e0e0e0; }`;

function authShell(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>${AUTH_CSS}</style></head><body><div class="card">${body}</div></body></html>`;
}

function hiddenParams(p: OAuthParams): string {
  return `<input type="hidden" name="client_id" value="${escapeHtml(p.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirect_uri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(p.code_challenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(p.code_challenge_method)}">
    <input type="hidden" name="state" value="${escapeHtml(p.state)}">`;
}

function operatorFormBody(clientLabel: string, p: OAuthParams, csrf: string): string {
  const workspaceCheckboxes = ALL_WORKSPACES.map((ws) => {
    const defaultChecked = ws !== "nora";
    return `<label class="scope"><input type="checkbox" name="scope" value="${ws}" ${defaultChecked ? "checked" : ""}><span>${ws}</span></label>`;
  }).join("");
  return `<form method="POST" action="/oauth/authorize">
    <input type="hidden" name="flow" value="operator">
    ${hiddenParams(p)}
    <input type="hidden" name="_csrf" value="${csrf}">
    <div class="scopes">${workspaceCheckboxes}</div>
    <label for="password">Senha de operador:</label>
    <input type="password" id="password" name="password" required placeholder="Senha">
    <button type="submit">Autorizar (operador)</button>
  </form>`;
}

function renderFriendEmail(clientLabel: string, p: OAuthParams, csrf: string, err = ""): string {
  return authShell("Conectar — Zinom", `
    <h1>🧠 Conectar ${escapeHtml(clientLabel)}</h1>
    <p class="subtitle">Entre com seu e-mail para autorizar o acesso ao <span class="client-name">seu Zinom</span>.</p>
    ${err ? `<p class="err">${escapeHtml(err)}</p>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="flow" value="friend_email">
      ${hiddenParams(p)}
      <input type="hidden" name="_csrf" value="${csrf}">
      <label for="email">Seu e-mail</label>
      <input type="email" id="email" name="email" required placeholder="voce@email.com">
      <button type="submit">Enviar código</button>
    </form>
    <details><summary>Sou o operador (senha de admin)</summary>
      ${operatorFormBody(clientLabel, p, csrf)}
    </details>`);
}

function renderFriendCode(clientLabel: string, p: OAuthParams, csrf: string, email: string, msg = ""): string {
  return authShell("Código — Zinom", `
    <h1>Digite o código</h1>
    <p class="subtitle">Enviamos um código de 6 dígitos para <span class="client-name">${escapeHtml(email)}</span> (se houver uma conta). Vale 10 minutos.</p>
    ${msg ? `<p class="err">${escapeHtml(msg)}</p>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="flow" value="friend_code">
      ${hiddenParams(p)}
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <label for="code">Código</label>
      <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" autofocus>
      <button type="submit">Verificar</button>
    </form>`);
}

function renderFriendConsent(clientLabel: string, p: OAuthParams, csrf: string, email: string): string {
  return authShell("Autorizar — Zinom", `
    <h1>Autorizar acesso</h1>
    <p class="subtitle"><span class="client-name">${escapeHtml(clientLabel)}</span> quer acessar o Zinom de <strong>${escapeHtml(email)}</strong>.</p>
    <div class="perm">Permite buscar (<code>brain_search</code>) apenas no SEU conteúdo. Nenhuma outra conta é acessível.</div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="flow" value="friend_consent">
      ${hiddenParams(p)}
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">Autorizar</button>
    </form>`);
}

// --- Token lookup ---

export function getAccessTokenInfo(token: string): AccessToken | null {
  // Reject revoked tokens (additive guard; uses the unit-tested pure helper).
  // Backward compatible: a pre-existing access token with no refresh token and
  // no revocation marker validates exactly as before.
  if (isRevokedPure({ accessTokens: [], refreshTokens: [], revoked: revokedTokens }, token)) {
    return null;
  }
  const entry = accessTokens.get(token);
  if (!entry) return null;
  if (isTokenExpired(entry.expires_at, Date.now())) {
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
    const expiry = openRegistrationWindow(ENROLLMENT_WINDOW_MS);
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    console.log(
      `[${new Date().toISOString()}] OAuth: registration window opened until ${new Date(expiry).toISOString()} by ${ip}`
    );
    res.json({
      open_until: new Date(expiry).toISOString(),
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
    closeRegistrationWindow();
    console.log(`[${new Date().toISOString()}] OAuth: registration window closed manually`);
    res.json({ ok: true });
  });

  // Admin: revoke tokens. Body: { "client_id": "..." } OR { "token": "..." }.
  // Same bearer-gate pattern as open/close-registration.
  router.post("/admin/revoke", (req, res) => {
    if (!bearerToken) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), bearerToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const { client_id, token } = req.body ?? {};
    if (
      (typeof client_id !== "string" || client_id.length === 0) &&
      (typeof token !== "string" || token.length === 0)
    ) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "provide a non-empty client_id or token",
      });
      return;
    }

    let revokedCount = 0;
    if (typeof token === "string" && token.length > 0) {
      if (!revokedTokens.has(token)) {
        revokedTokens.add(token);
        revokedCount += 1;
      }
    }
    if (typeof client_id === "string" && client_id.length > 0) {
      for (const t of accessTokens.values()) {
        if (t.client_id === client_id && !revokedTokens.has(t.token)) {
          revokedTokens.add(t.token);
          revokedCount += 1;
        }
      }
      for (const t of refreshTokens.values()) {
        if (t.client_id === client_id && !revokedTokens.has(t.token)) {
          revokedTokens.add(t.token);
          revokedCount += 1;
        }
      }
    }

    saveStore();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    console.log(
      `[${new Date().toISOString()}] OAuth: revoked ${revokedCount} token(s) (${client_id ? `client ${client_id}` : `token ${String(token).slice(0, 8)}…`}) by ${ip}`
    );
    res.json({ ok: true, revoked: revokedCount });
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
      grant_types_supported: ["authorization_code", "refresh_token"],
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
    saveStore();
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

  // Authorization endpoint — render consent page. Two flows share this endpoint:
  //  - FRIEND (per-account): if a portal session cookie is present → 1-click
  //    consent; else an inline email → 6-digit code login, then consent.
  //  - OPERATOR (Bruno): the admin-password + workspace-scope form (unchanged),
  //    available under a <details> on the no-session page.
  router.get("/oauth/authorize", async (req, res) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } =
      req.query as Record<string, string>;

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

    const p: OAuthParams = {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state: state || "",
    };
    const csrf = generateToken();
    csrfTokens.set(csrf, Date.now() + CSRF_TTL_MS);
    const clientLabel = client.client_name || client_id;
    const csp = "default-src 'self'; style-src 'unsafe-inline'";

    // Friend already signed into the portal in this browser → straight to consent.
    const accountId = await resolveSession(readCookie(req, SESSION_COOKIE)).catch(() => null);
    if (accountId) {
      const email = (await getAccountEmail(accountId).catch(() => null)) ?? "sua conta";
      res.header("Content-Security-Policy", csp).type("html").send(renderFriendConsent(clientLabel, p, csrf, email));
      return;
    }
    res.header("Content-Security-Policy", csp).type("html").send(renderFriendEmail(clientLabel, p, csrf));
  });

  // Issue a FRIEND (per-account) auth code and redirect back to the client.
  // Re-validates the client + redirect_uri (never trusts hidden form fields).
  const issueFriendAuthCode = async (res: any, p: OAuthParams, accountId: string): Promise<void> => {
    const client = clients.get(p.client_id);
    if (!client || !p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    const ws = await friendWorkspaces(accountId);
    const code = generateToken();
    authCodes.set(code, {
      code,
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      code_challenge_method: p.code_challenge_method,
      scopes: ws as Workspace[],
      accountId,
      expires_at: Date.now() + CODE_TTL_MS,
    });
    console.log(
      `[${new Date().toISOString()}] OAuth: issued FRIEND auth code for ${accountId} client ${p.client_id} (ws: ${ws.join(",")})`
    );
    const url = new URL(p.redirect_uri);
    url.searchParams.set("code", code);
    if (p.state) url.searchParams.set("state", p.state);
    res.redirect(302, url.toString());
  };

  // Authorization POST (consent form submission). Branches: friend_email →
  // friend_code → (auth code); friend_consent (session) → (auth code); operator
  // (admin password + workspace scopes, unchanged).
  router.post("/oauth/authorize", async (req, res) => {
    const { flow, client_id, redirect_uri, code_challenge, code_challenge_method, state, _csrf } = req.body;
    const p: OAuthParams = {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state: state || "",
    };
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const csp = "default-src 'self'; style-src 'unsafe-inline'";
    const newCsrf = () => {
      const c = generateToken();
      csrfTokens.set(c, Date.now() + CSRF_TTL_MS);
      return c;
    };
    const clientLabel = clients.get(client_id)?.client_name || client_id || "o app";

    // CSRF (all flows, single-use).
    if (!_csrf || !csrfTokens.has(_csrf)) {
      res.status(403).json({ error: "invalid_csrf_token" });
      return;
    }
    csrfTokens.delete(_csrf);

    // FRIEND — email step: send a login code (only if the email maps to an
    // account; generic either way to avoid enumeration), render the code page.
    if (flow === "friend_email") {
      const email = normalizeEmail(typeof req.body.email === "string" ? req.body.email : "");
      if (!isLikelyEmail(email)) {
        res.header("Content-Security-Policy", csp).type("html").send(renderFriendEmail(clientLabel, p, newCsrf(), "E-mail inválido."));
        return;
      }
      // Per-email send cap (anti-bombing). Checked BEFORE issuing and uniformly
      // for any email, so it neither bombs an inbox nor leaks account existence.
      if (issueBlocked(email)) {
        res.header("Content-Security-Policy", csp).type("html").send(renderFriendCode(clientLabel, p, newCsrf(), email, "Muitos códigos enviados. Aguarde alguns minutos e tente de novo."));
        return;
      }
      recordIssue(email);
      try {
        const acct = await findAccountByEmail(email);
        if (acct) {
          const code = await issueLoginCode(email, acct);
          void sendLoginCodeEmail(email, code).catch((e) => console.error(`[oauth] code send failed: ${e?.message ?? e}`));
        }
      } catch (e: any) {
        console.error(`[oauth] friend_email failed: ${e?.message ?? e}`);
      }
      res.header("Content-Security-Policy", csp).type("html").send(renderFriendCode(clientLabel, p, newCsrf(), email));
      return;
    }

    // FRIEND — code step: verify the code, then issue the auth code.
    if (flow === "friend_code") {
      const email = normalizeEmail(typeof req.body.email === "string" ? req.body.email : "");
      const code = String(req.body.code ?? "").trim();
      if (codeBlocked(email)) {
        res.header("Content-Security-Policy", csp).type("html").send(renderFriendCode(clientLabel, p, newCsrf(), email, "Muitas tentativas. Peça um novo código pelo Claude.ai."));
        return;
      }
      const r = await consumeLoginCode(email, code).catch(() => null);
      if (!r || !r.accountId) {
        recordCodeFail(email);
        res.header("Content-Security-Policy", csp).type("html").send(renderFriendCode(clientLabel, p, newCsrf(), email, "Código inválido ou expirado."));
        return;
      }
      await issueFriendAuthCode(res, p, r.accountId);
      return;
    }

    // FRIEND — 1-click consent (already signed into the portal in this browser).
    if (flow === "friend_consent") {
      const accountId = await resolveSession(readCookie(req, SESSION_COOKIE)).catch(() => null);
      if (!accountId) {
        res.header("Content-Security-Policy", csp).type("html").send(renderFriendEmail(clientLabel, p, newCsrf(), "Sessão expirada. Entre com seu e-mail."));
        return;
      }
      await issueFriendAuthCode(res, p, accountId);
      return;
    }

    // OPERATOR — admin password + workspace scopes (unchanged behavior).
    if (isBlocked(ip)) {
      console.warn(`[${new Date().toISOString()}] OAuth: blocked login attempt from ${ip} (too many failures)`);
      res.status(429).type("html").send(`<!DOCTYPE html>
<html><head><title>Blocked</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#ef5350;}</style>
</head><body><h2>Too many failed attempts. Try again in 5 minutes.</h2></body></html>`);
      return;
    }
    const { password, scope } = req.body;
    if (!password || typeof password !== "string" || !verifyPassword(password)) {
      recordFailedAttempt(ip);
      console.warn(`[${new Date().toISOString()}] OAuth: failed password attempt from ${ip}`);
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
    const client = clients.get(client_id)!;
    if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
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
      kind: "operator", // admin-password flow → owner tools/instructions at /mcp
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
      refresh_token,
    } = req.body;

    // --- refresh_token grant (rotation) ---
    if (grant_type === "refresh_token") {
      if (!refresh_token || typeof refresh_token !== "string") {
        res.status(400).json({ error: "invalid_request", error_description: "refresh_token required" });
        return;
      }
      if (!client_id || !clients.has(client_id)) {
        res.status(400).json({ error: "invalid_client" });
        return;
      }
      // Verify client_secret for confidential clients (same rule as auth_code).
      const rc = clients.get(client_id);
      if (rc?.client_secret) {
        if (!client_secret || !safeEqual(client_secret, rc.client_secret)) {
          res.status(401).json({ error: "invalid_client", error_description: "invalid client_secret" });
          return;
        }
      }

      const now = Date.now();
      // Validate via the unit-tested pure helper (exists, matches client, not
      // expired, not revoked).
      const validation = validateRefreshTokenPure(snapshotStore(), refresh_token, client_id, now);
      if (!validation.ok) {
        res.status(400).json({ error: "invalid_grant", error_description: validation.reason });
        return;
      }

      const grantedScopes = validation.record.scopes as Workspace[];
      const grantedAccountId = (validation.record as RefreshToken).accountId;
      const grantedKind = (validation.record as RefreshToken).kind;

      // ROTATE: mint a new access token + new refresh token (preserving scopes +
      // accountId), invalidate the old refresh token (drop + revoke for replay).
      const newAccess = generateToken();
      const newRefresh = generateToken();
      accessTokens.set(newAccess, {
        token: newAccess,
        client_id,
        scopes: grantedScopes,
        accountId: grantedAccountId,
        kind: grantedKind,
        expires_at: now + ACCESS_TTL_MS,
      });
      refreshTokens.set(newRefresh, {
        token: newRefresh,
        client_id,
        scopes: grantedScopes,
        accountId: grantedAccountId,
        kind: grantedKind,
        expires_at: now + REFRESH_TTL_MS,
      });
      refreshTokens.delete(refresh_token);
      revokedTokens.add(refresh_token);
      saveStore();

      const ipR = req.ip || req.socket.remoteAddress || "unknown";
      console.log(
        `[${new Date().toISOString()}] OAuth: rotated refresh token for client ${client_id} from ${ipR} (scopes: ${grantedScopes.join(",")})`
      );

      res.json({
        access_token: newAccess,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_MS / 1000,
        refresh_token: newRefresh,
        scope: grantedScopes.join(" "),
      });
      return;
    }

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

    // Issue access token with scopes inherited from the auth code. NEW tokens
    // use the configurable (shorter) ACCESS_TTL_MS; existing persisted tokens
    // are untouched.
    const now = Date.now();
    const token = generateToken();
    const expiresIn = ACCESS_TTL_MS / 1000;
    accessTokens.set(token, {
      token,
      client_id,
      scopes: authCode.scopes,
      accountId: authCode.accountId, // friend flow → /mcp scopes to this account
      kind: authCode.kind, // operator flow → owner; friend leaves this undefined
      expires_at: now + ACCESS_TTL_MS,
    });

    // ALSO mint a refresh token bound to {client_id, scopes, accountId}, returned
    // alongside the access token. Additive — clients that ignore it are unaffected.
    const refreshToken = generateToken();
    refreshTokens.set(refreshToken, {
      token: refreshToken,
      client_id,
      scopes: authCode.scopes,
      accountId: authCode.accountId,
      kind: authCode.kind,
      expires_at: now + REFRESH_TTL_MS,
    });
    saveStore();

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    console.log(
      `[${new Date().toISOString()}] OAuth: issued access + refresh token for client ${client_id} from ${ip} (scopes: ${authCode.scopes.join(",")})`
    );

    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: authCode.scopes.join(" "),
    });
  });

  return router;
}
