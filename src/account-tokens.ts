// src/account-tokens.ts
// F3.2b — per-account token resolution. The built-in account 'bruno' keeps using
// .env (clients.ts is unchanged for it). Onboarded accounts (notion:* / notion-pat:*)
// resolve their Notion token from the encrypted vault, cached in memory after a
// one-time async warm. Their workspaces are DYNAMIC (a Notion workspace_id), not
// the fixed personal/globalcripto/nora enum.
//
// Kept out of clients.ts (which process.exit()s at load without NOTION_*_TOKEN)
// so it stays unit-testable with no env.
import { getPool } from "./rag/storage.js";
import { getAccountSecret } from "./secrets.js";
import { DEFAULT_ACCOUNT_ID } from "./context.js";

// accountId -> ("pat:<ws>" | "search:<ws>") -> token
const cache = new Map<string, Map<string, string>>();

/** Test seam: drop all cached account tokens. */
export function __clearAccountTokenCache(): void {
  cache.clear();
}

export function isWarmed(accountId: string): boolean {
  return cache.has(accountId);
}

/**
 * Decrypt + cache an account's tokens; returns its workspaces. The OAuth access
 * token also serves /v1/search (Notion OAuth tokens can search); a PAT is reused
 * for both (search returns 0 for PATs — the caller handles discovery differently).
 * 'bruno' is never cached here (it resolves from .env in clients.ts).
 */
export async function warmAccount(accountId: string): Promise<string[]> {
  if (accountId === DEFAULT_ACCOUNT_ID) return [];
  const p = getPool();
  const { rows } = await p.query<{ workspace: string }>(
    `SELECT workspace FROM account_workspaces WHERE account_id=$1`,
    [accountId],
  );
  const m = new Map<string, string>();
  const workspaces: string[] = [];
  for (const { workspace } of rows) {
    const access = await getAccountSecret(accountId, `notion_access:${workspace}`);
    const token = access ?? (await getAccountSecret(accountId, `notion_pat:${workspace}`));
    if (!token) continue;
    m.set(`pat:${workspace}`, token);
    m.set(`search:${workspace}`, token);
    workspaces.push(workspace);
  }
  cache.set(accountId, m);
  return workspaces;
}

/** Cached token for (account, workspace, kind); undefined if not warmed/known. */
export function getAccountToken(
  accountId: string,
  workspace: string,
  kind: "pat" | "search" = "pat",
): string | undefined {
  return cache.get(accountId)?.get(`${kind}:${workspace}`);
}

/**
 * Bug #96 (2a) — cache-miss fallback. Returns the cached token when present;
 * otherwise fetches the secret straight from the vault (notion_access first,
 * then notion_pat), populates the cache for both kinds, and returns it.
 * undefined when the vault has nothing — the caller throws as before.
 * 'bruno' never resolves here (env tokens in clients.ts).
 */
export async function ensureAccountToken(
  accountId: string,
  workspace: string,
  kind: "pat" | "search" = "pat",
): Promise<string | undefined> {
  if (accountId === DEFAULT_ACCOUNT_ID) return undefined;
  const cached = cache.get(accountId)?.get(`${kind}:${workspace}`);
  if (cached) return cached;
  const access = await getAccountSecret(accountId, `notion_access:${workspace}`);
  const token = access ?? (await getAccountSecret(accountId, `notion_pat:${workspace}`));
  if (!token) return undefined;
  let m = cache.get(accountId);
  if (!m) {
    m = new Map();
    cache.set(accountId, m);
  }
  m.set(`pat:${workspace}`, token);
  m.set(`search:${workspace}`, token);
  return token;
}

// Bug #96 (2b) — invalidation hooks. clients.ts registers one to also purge its
// per-account Client cache (we can't import clients.ts here: it process.exit()s
// without NOTION_* env).
type InvalidateHook = (accountId: string) => void;
const invalidateHooks: InvalidateHook[] = [];

/** Register a callback fired whenever an account's tokens are invalidated. */
export function onAccountTokensInvalidated(hook: InvalidateHook): void {
  invalidateHooks.push(hook);
}

/** Drop an account's cached tokens (call when a workspace is connected or
 *  disconnected so stale tokens/clients never outlive the credential). */
export function invalidateAccountTokens(accountId: string): void {
  cache.delete(accountId);
  for (const hook of invalidateHooks) hook(accountId);
}

/** Bug #96 (2c) — true iff the error is the cache-miss "no <kind> token ..."
 *  thrown by clients.ts. Lets notion-source aggregate these skips into one
 *  summary log per workspace instead of one line per database. */
export function isMissingTokenError(err: unknown): boolean {
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === "string" && /^no (pat|search) token for account /.test(msg);
}

/** Workspaces of a warmed account (empty if not warmed). */
export function getWarmedWorkspaces(accountId: string): string[] {
  const m = cache.get(accountId);
  if (!m) return [];
  return [...new Set([...m.keys()].map((k) => k.slice(k.indexOf(":") + 1)))];
}
