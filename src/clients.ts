import { Client } from "@notionhq/client";
import { assertWorkspaceScope, getAccountId, DEFAULT_ACCOUNT_ID } from "./context.js";
import { getAccountToken, ensureAccountToken, onAccountTokensInvalidated } from "./account-tokens.js";

// PAT tokens — used for ALL operations except /v1/search.
// PATs inherit the creator user's permissions (full read/write by ID) but
// /v1/search returns 0 for them. So we keep an internal-integration token
// per workspace for search/discovery only.
const patTokens = [
  "NOTION_GLOBALCRIPTO_TOKEN",
  "NOTION_PERSONAL_TOKEN",
  "NOTION_NORA_TOKEN",
] as const;

// Internal-integration tokens — used ONLY for /v1/search.
// Optional: if missing, the corresponding workspace falls back to the PAT
// for search (which returns empty), preserving boot-up but losing discovery.
const searchTokens = [
  "NOTION_GLOBALCRIPTO_SEARCH_TOKEN",
  "NOTION_PERSONAL_SEARCH_TOKEN",
  "NOTION_NORA_SEARCH_TOKEN",
] as const;

for (const key of patTokens) {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  if (!val.startsWith("ntn_")) {
    console.error(`Invalid format for ${key}: must start with "ntn_"`);
    process.exit(1);
  }
}

for (const key of searchTokens) {
  const val = process.env[key];
  if (val && !val.startsWith("ntn_")) {
    console.error(`Invalid format for ${key}: must start with "ntn_"`);
    process.exit(1);
  }
  if (!val) {
    console.warn(`[clients] ${key} not set — search/discovery in that workspace will return empty.`);
  }
}

if (!process.env.OAUTH_PASSWORD_HASH) {
  console.error(
    "Missing required environment variable: OAUTH_PASSWORD_HASH.\n" +
      "Generate one with: node scripts/hash-password.mjs '<your-password>'"
  );
  process.exit(1);
}

const bearerToken = process.env.BEARER_TOKEN;
if (bearerToken && bearerToken.length < 32) {
  console.error("BEARER_TOKEN must be at least 32 characters");
  process.exit(1);
}

// Notion API version. 2025-09-03 unlocks multi-source databases,
// data_sources endpoints, comments threading, and file uploads.
export const NOTION_API_VERSION = "2025-09-03";

// PAT clients (default — used everywhere except search).
export const globalcriptoClient = new Client({
  auth: process.env.NOTION_GLOBALCRIPTO_TOKEN!,
  notionVersion: NOTION_API_VERSION,
});

export const personalClient = new Client({
  auth: process.env.NOTION_PERSONAL_TOKEN!,
  notionVersion: NOTION_API_VERSION,
});

export const noraClient = new Client({
  auth: process.env.NOTION_NORA_TOKEN!,
  notionVersion: NOTION_API_VERSION,
});

// Search clients (internal integrations — used only by /v1/search-backed flows).
// Fall back to the PAT client if no search token is configured.
export const globalcriptoSearchClient = process.env.NOTION_GLOBALCRIPTO_SEARCH_TOKEN
  ? new Client({ auth: process.env.NOTION_GLOBALCRIPTO_SEARCH_TOKEN, notionVersion: NOTION_API_VERSION })
  : globalcriptoClient;

export const personalSearchClient = process.env.NOTION_PERSONAL_SEARCH_TOKEN
  ? new Client({ auth: process.env.NOTION_PERSONAL_SEARCH_TOKEN, notionVersion: NOTION_API_VERSION })
  : personalClient;

export const noraSearchClient = process.env.NOTION_NORA_SEARCH_TOKEN
  ? new Client({ auth: process.env.NOTION_NORA_SEARCH_TOKEN, notionVersion: NOTION_API_VERSION })
  : noraClient;

export type Workspace = "globalcripto" | "personal" | "nora";

export const ALL_WORKSPACES: Workspace[] = ["globalcripto", "personal", "nora"];

export type TokenKind = "pat" | "search";

// F3.2b — per-account Client cache for onboarded (non-'bruno') accounts. Built
// from vault tokens warmed by account-tokens.ts. 'bruno' uses the env singletons.
const accountClientCache = new Map<string, Client>();

// Bug #96 (2b): when an account's tokens are invalidated (workspace connected or
// disconnected), purge its cached Clients too — otherwise a stale Client built
// from the removed credential survives until the process restarts.
onAccountTokensInvalidated((accountId) => {
  for (const key of accountClientCache.keys()) {
    if (key.startsWith(`${accountId}:`)) accountClientCache.delete(key);
  }
});

function resolveAccountClient(accountId: string, workspace: string, kind: TokenKind): Client {
  const key = `${accountId}:${kind}:${workspace}`;
  // Bug #96 (2): validate against the token cache BEFORE trusting the Client
  // cache — a Client for a workspace whose token is gone (disconnected, or
  // dropped by a warmAccount reset) must not outlive the credential.
  const token = getAccountToken(accountId, workspace, kind);
  if (!token) {
    accountClientCache.delete(key);
    throw new Error(
      `no ${kind} token for account "${accountId}" workspace "${workspace}" (warmAccount first)`,
    );
  }
  const cached = accountClientCache.get(key);
  if (cached) return cached;
  const client = new Client({ auth: token, notionVersion: NOTION_API_VERSION });
  accountClientCache.set(key, client);
  return client;
}

export function getClient(workspace: Workspace, accountId: string = getAccountId()): Client {
  // Per-request scope enforcement (no-op when there's no HTTP context).
  assertWorkspaceScope(workspace);
  if (accountId !== DEFAULT_ACCOUNT_ID) return resolveAccountClient(accountId, workspace, "pat");
  switch (workspace) {
    case "globalcripto":
      return globalcriptoClient;
    case "personal":
      return personalClient;
    case "nora":
      return noraClient;
    default:
      throw new Error(`Unknown workspace: ${workspace}`);
  }
}

/** Async getClient: on a cache-miss for an onboarded account it falls back to
 *  the vault (ensureAccountToken) before failing — covers tokens connected after
 *  the account was last warmed (bug #96 2a). */
export async function getClientAsync(
  workspace: Workspace,
  accountId: string = getAccountId(),
): Promise<Client> {
  if (accountId !== DEFAULT_ACCOUNT_ID && !getAccountToken(accountId, workspace, "pat")) {
    await ensureAccountToken(accountId, workspace, "pat");
  }
  return getClient(workspace, accountId);
}

export function getSearchClient(workspace: Workspace, accountId: string = getAccountId()): Client {
  assertWorkspaceScope(workspace);
  if (accountId !== DEFAULT_ACCOUNT_ID) return resolveAccountClient(accountId, workspace, "search");
  switch (workspace) {
    case "globalcripto":
      return globalcriptoSearchClient;
    case "personal":
      return personalSearchClient;
    case "nora":
      return noraSearchClient;
    default:
      throw new Error(`Unknown workspace: ${workspace}`);
  }
}

/** Async getSearchClient with the same vault fallback as getClientAsync. */
export async function getSearchClientAsync(
  workspace: Workspace,
  accountId: string = getAccountId(),
): Promise<Client> {
  if (accountId !== DEFAULT_ACCOUNT_ID && !getAccountToken(accountId, workspace, "search")) {
    await ensureAccountToken(accountId, workspace, "search");
  }
  return getSearchClient(workspace, accountId);
}

export function getToken(
  workspace: Workspace,
  kind: TokenKind = "pat",
  accountId: string = getAccountId(),
): string {
  assertWorkspaceScope(workspace);
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    const token = getAccountToken(accountId, workspace, kind);
    if (!token) {
      throw new Error(
        `no ${kind} token for account "${accountId}" workspace "${workspace}" (warmAccount first)`,
      );
    }
    return token;
  }
  if (kind === "search") {
    switch (workspace) {
      case "globalcripto":
        return process.env.NOTION_GLOBALCRIPTO_SEARCH_TOKEN ?? process.env.NOTION_GLOBALCRIPTO_TOKEN!;
      case "personal":
        return process.env.NOTION_PERSONAL_SEARCH_TOKEN ?? process.env.NOTION_PERSONAL_TOKEN!;
      case "nora":
        return process.env.NOTION_NORA_SEARCH_TOKEN ?? process.env.NOTION_NORA_TOKEN!;
      default:
        throw new Error(`Unknown workspace: ${workspace}`);
    }
  }
  switch (workspace) {
    case "globalcripto":
      return process.env.NOTION_GLOBALCRIPTO_TOKEN!;
    case "personal":
      return process.env.NOTION_PERSONAL_TOKEN!;
    case "nora":
      return process.env.NOTION_NORA_TOKEN!;
    default:
      throw new Error(`Unknown workspace: ${workspace}`);
  }
}

// Optional manifest of extra data_source IDs to index per workspace.
// Format: JSON object in NOTION_EXTRA_DATA_SOURCES env var. PATs can read
// these IDs without being shared — useful for content not visible to the
// internal integration's /v1/search.
//   NOTION_EXTRA_DATA_SOURCES='{"personal":["id1","id2"],"nora":["id3"]}'
export function getExtraDataSources(workspace: Workspace): string[] {
  const raw = process.env.NOTION_EXTRA_DATA_SOURCES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = parsed[workspace];
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    console.warn("[clients] NOTION_EXTRA_DATA_SOURCES is not valid JSON; ignoring.");
    return [];
  }
}

export interface NotionFetchInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  contentType?: string;
  rawBody?: BodyInit;
  // Which token family to use. Defaults to "pat" (full user access).
  // Set "search" for /v1/search and any other discovery-style call that
  // must run against an integration-scoped index.
  tokenKind?: TokenKind;
}

/**
 * Raw HTTP call to the Notion REST API for endpoints not yet covered by
 * the @notionhq/client SDK (data sources, file uploads, etc).
 * Adds workspace-scoped auth + the active Notion-Version header.
 */
export async function notionFetch(
  workspace: Workspace,
  path: string,
  init: NotionFetchInit = {}
): Promise<unknown> {
  // Bug #96 (2a): for onboarded accounts, a token-cache miss falls back to the
  // vault (ensureAccountToken) before failing — getToken alone would throw on
  // a workspace connected after the last warmAccount.
  const kind = init.tokenKind ?? "pat";
  const accountId = getAccountId();
  let token: string;
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    assertWorkspaceScope(workspace);
    const resolved =
      getAccountToken(accountId, workspace, kind) ??
      (await ensureAccountToken(accountId, workspace, kind));
    if (!resolved) {
      throw new Error(
        `no ${kind} token for account "${accountId}" workspace "${workspace}" (warmAccount first)`,
      );
    }
    token = resolved;
  } else {
    token = getToken(workspace, kind);
  }
  const base = path.startsWith("http") ? path : `https://api.notion.com${path}`;
  let url = base;
  if (init.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const sep = base.includes("?") ? "&" : "?";
    url = base + (qs.toString() ? `${sep}${qs.toString()}` : "");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
  };
  if (init.contentType) {
    headers["Content-Type"] = init.contentType;
  } else if (init.body !== undefined && !init.rawBody) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });

  const text = await resp.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!resp.ok) {
    const err = (data ?? {}) as { message?: string; code?: string; request_id?: string };
    const msg = err.message ?? `HTTP ${resp.status}`;
    const e = new Error(msg) as Error & { code?: string; request_id?: string; status?: number };
    e.code = err.code;
    e.request_id = err.request_id;
    e.status = resp.status;
    throw e;
  }
  return data;
}
