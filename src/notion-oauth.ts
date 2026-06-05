// src/notion-oauth.ts
// F3.2 — Notion public-integration OAuth onboarding. A user authorizes our
// connection to read THEIR Notion; we exchange the code for tokens, create an
// account, and store the tokens ENCRYPTED via the F3.1 vault. This is distinct
// from src/oauth.ts (our MCP server's own OAuth for Claude.ai access).
//
// No clients.ts import here (it process.exit()s when NOTION_*_TOKEN are unset,
// which would break unit tests) — the OAuth token endpoint needs no Notion-Version.
import { setAccountSecret } from "./secrets.js";
import { getPool } from "./rag/storage.js";

const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/** Stable account id for a connected Notion workspace (P1: account = a Notion
 *  OAuth identity). Prefixed so it never collides with the built-in 'bruno'. */
export function accountIdForWorkspace(workspaceId: string): string {
  return `notion:${workspaceId}`;
}

/** Build the Notion authorize URL the user is sent to (response_type=code,
 *  owner=user per the docs). `state` is the CSRF nonce. */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state?: string;
}): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("owner", "user");
  u.searchParams.set("redirect_uri", opts.redirectUri);
  if (opts.state) u.searchParams.set("state", opts.state);
  return u.toString();
}

export interface NotionTokenResponse {
  access_token: string;
  refresh_token?: string | null;
  bot_id?: string;
  workspace_id: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  owner?: unknown;
}

/** Exchange an authorization code for tokens (POST /v1/oauth/token, HTTP Basic
 *  with client_id:client_secret). fetchImpl is injectable for tests. */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  opts: { clientId: string; clientSecret: string; fetchImpl?: typeof fetch },
): Promise<NotionTokenResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const text = await res.text();
  let data: NotionTokenResponse & { error?: string; error_description?: string };
  try {
    data = (text ? JSON.parse(text) : {}) as typeof data;
  } catch {
    // Non-JSON body (CDN/proxy error page) — don't leak the raw HTML/parse error.
    throw new Error(`notion token exchange: resposta não-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(
      `notion token exchange failed: HTTP ${res.status} ${data?.error ?? ""} ${data?.error_description ?? ""}`.trim(),
    );
  }
  if (!data.access_token || !data.workspace_id) {
    throw new Error("notion token response missing access_token/workspace_id");
  }
  return data;
}

/**
 * Persist a freshly-connected Notion account: create the account + its single
 * workspace, and store the access (and refresh) tokens ENCRYPTED in the vault.
 * Idempotent — re-connecting the same workspace refreshes status + tokens.
 */
export async function onboardAccount(
  tok: NotionTokenResponse,
): Promise<{ accountId: string; workspace: string }> {
  const accountId = accountIdForWorkspace(tok.workspace_id);
  const workspace = tok.workspace_id; // one workspace per onboarded Notion account
  const p = getPool();
  await p.query(
    `INSERT INTO account (id, kind, status) VALUES ($1, 'notion', 'active')
     ON CONFLICT (id) DO UPDATE SET status = 'active'`,
    [accountId],
  );
  await p.query(
    `INSERT INTO account_workspaces (account_id, workspace) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [accountId, workspace],
  );
  await setAccountSecret(accountId, `notion_access:${workspace}`, tok.access_token);
  if (tok.refresh_token) {
    await setAccountSecret(accountId, `notion_refresh:${workspace}`, tok.refresh_token);
  }
  return { accountId, workspace };
}
