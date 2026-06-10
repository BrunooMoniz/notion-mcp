// src/account-bearer.ts
// F3.2c — per-account MCP bearer tokens. An onboarded account gets a personal
// bearer (shown once) that it puts in Claude; the /mcp middleware resolves it
// (by SHA-256 hash) to the account and scopes brain_search to that account only.
// Only the hash is stored — never the token. 'bruno' keeps the env BEARER_TOKEN.
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./rag/storage.js";

const PREFIX = "acct_"; // lets the middleware cheaply skip non-account tokens

export function generateBearer(): string {
  return `${PREFIX}${randomBytes(24).toString("hex")}`;
}

export function hashBearer(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// token_hash -> resolved account (short-TTL cache so a revoked/deleted token
// stops working within TTL_MS without a process restart — see resolveBearer/revoke).
const TTL_MS = 60_000;
const cache = new Map<string, { accountId: string; workspaces: string[]; label: string | null; exp: number }>();
export function __clearBearerCache(): void {
  cache.clear();
}

/** Revoke ALL bearers for an account (delete rows + drop cache). Returns the
 *  number of tokens revoked. A revoked token stops resolving immediately (cache
 *  cleared) and is gone from the DB. */
export async function revokeBearersForAccount(accountId: string): Promise<number> {
  const p = getPool();
  const res = await p.query(`DELETE FROM account_api_tokens WHERE account_id=$1`, [accountId]);
  cache.clear(); // simplest correct invalidation (cache is tiny)
  return res.rowCount ?? 0;
}

/** Issue a fresh per-account bearer; store ONLY its hash. Returns the plaintext
 *  token (caller shows it to the user once). */
export async function issueBearer(accountId: string, label?: string): Promise<string> {
  const token = generateBearer();
  const p = getPool();
  await p.query(
    `INSERT INTO account_api_tokens (token_hash, account_id, label) VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO NOTHING`,
    [hashBearer(token), accountId, label ?? null],
  );
  return token;
}

/** The account's currently-granted workspaces (its account_workspaces). Used to
 *  scope a friend's OAuth token FRESH per request, so sources connected after the
 *  token was issued are still visible without re-authorizing. Ordered by
 *  created_at ASC (first workspace connected) so callers that fall back to
 *  ws[0] (e.g. the index-web default workspace tag) are deterministic. */
export async function accountWorkspaces(accountId: string): Promise<string[]> {
  const p = getPool();
  const { rows } = await p.query<{ workspace: string }>(
    `SELECT workspace FROM account_workspaces WHERE account_id=$1 ORDER BY created_at ASC`,
    [accountId],
  );
  return rows.map((r) => r.workspace);
}

/** True iff the account already has at least one MCP bearer issued. Lets the
 *  portal show "token gerado" vs "gerar token" without revealing the token. */
export async function accountHasBearer(accountId: string): Promise<boolean> {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT 1 FROM account_api_tokens WHERE account_id=$1 LIMIT 1`,
    [accountId],
  );
  return rows.length > 0;
}

/** Resolve a presented bearer to its account + workspaces + label, or null.
 *  Fast-rejects anything without the account prefix (so BEARER_TOKEN/OAuth never
 *  hit the DB). The label feeds RequestContext.tokenLabel (ai_search_log). */
export async function resolveBearer(
  token: string | null | undefined,
): Promise<{ accountId: string; workspaces: string[]; label: string | null } | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const hash = hashBearer(token);
  const cached = cache.get(hash);
  if (cached && cached.exp > Date.now()) {
    return { accountId: cached.accountId, workspaces: cached.workspaces, label: cached.label };
  }
  if (cached) cache.delete(hash); // expired
  const p = getPool();
  const { rows } = await p.query<{ account_id: string; label: string | null }>(
    `SELECT account_id, label FROM account_api_tokens WHERE token_hash=$1`,
    [hash],
  );
  if (!rows[0]) return null;
  const accountId = rows[0].account_id;
  // Same deterministic ordering as accountWorkspaces: the tool-side fallback
  // (getAllowedWorkspaces()[0], e.g. brain_index_web) must always pick the
  // first-connected workspace, not whatever the planner returned first.
  const ws = await p.query<{ workspace: string }>(
    `SELECT workspace FROM account_workspaces WHERE account_id=$1 ORDER BY created_at ASC`,
    [accountId],
  );
  const resolved = { accountId, workspaces: ws.rows.map((r) => r.workspace), label: rows[0].label ?? null };
  cache.set(hash, { ...resolved, exp: Date.now() + TTL_MS });
  return resolved;
}
