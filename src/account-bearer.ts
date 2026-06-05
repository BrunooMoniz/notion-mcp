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

// token_hash -> resolved account (cache; per-account bearers are long-lived)
const cache = new Map<string, { accountId: string; workspaces: string[] }>();
export function __clearBearerCache(): void {
  cache.clear();
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

/** Resolve a presented bearer to its account + workspaces, or null. Fast-rejects
 *  anything without the account prefix (so BEARER_TOKEN/OAuth never hit the DB). */
export async function resolveBearer(
  token: string | null | undefined,
): Promise<{ accountId: string; workspaces: string[] } | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const hash = hashBearer(token);
  const cached = cache.get(hash);
  if (cached) return cached;
  const p = getPool();
  const { rows } = await p.query<{ account_id: string }>(
    `SELECT account_id FROM account_api_tokens WHERE token_hash=$1`,
    [hash],
  );
  if (!rows[0]) return null;
  const accountId = rows[0].account_id;
  const ws = await p.query<{ workspace: string }>(
    `SELECT workspace FROM account_workspaces WHERE account_id=$1`,
    [accountId],
  );
  const resolved = { accountId, workspaces: ws.rows.map((r) => r.workspace) };
  cache.set(hash, resolved);
  return resolved;
}
