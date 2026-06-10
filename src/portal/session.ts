// src/portal/session.ts
// 001-account-portal — server-side portal sessions. The opaque cookie carries a
// random id; only its SHA-256 hash lives in portal_sessions (a leaked DB row can
// never be replayed as a cookie). Mirrors the hash-at-rest discipline of
// account-bearer.ts. Distinct from the MCP `acct_` bearer: this authenticates the
// browser portal, not MCP queries. Sliding ~30-day expiry refreshed on resolve.
import { createHash, randomBytes } from "node:crypto";
import { getPool } from "../rag/storage.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
export const SESSION_COOKIE = "portal_session";

export function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export function hashSession(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/** Max stored user-agent length — enough to recognize a browser/device. */
const USER_AGENT_MAX_CHARS = 200;

/** Create a session for an account; store only the hash. Returns the plaintext
 *  id the caller sets as the cookie value. `userAgent` (002-app-v2) is the
 *  browser's User-Agent at sign-in, truncated, shown in "Sessões ativas". */
export async function createSession(
  accountId: string,
  now: Date = new Date(),
  ttlMs: number = SESSION_TTL_MS,
  userAgent?: string | null,
): Promise<string> {
  const id = generateSessionId();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const p = getPool();
  await p.query(
    `INSERT INTO portal_sessions (session_hash, account_id, expires_at, last_seen_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashSession(id), accountId, expiresAt, now, userAgent ? userAgent.slice(0, USER_AGENT_MAX_CHARS) : null],
  );
  return id;
}

/** Resolve a cookie id to its account_id, or null if absent/expired. Slides the
 *  expiry forward on a hit. Scope is taken from here (the trusted store), never
 *  from request input. */
export async function resolveSession(
  id: string | null | undefined,
  now: Date = new Date(),
  ttlMs: number = SESSION_TTL_MS,
): Promise<string | null> {
  if (!id) return null;
  const hash = hashSession(id);
  const p = getPool();
  const { rows } = await p.query<{ account_id: string }>(
    `SELECT account_id FROM portal_sessions WHERE session_hash=$1 AND expires_at > $2`,
    [hash, now],
  );
  if (!rows[0]) return null;
  const expiresAt = new Date(now.getTime() + ttlMs);
  await p.query(
    `UPDATE portal_sessions SET last_seen_at=$2, expires_at=$3 WHERE session_hash=$1`,
    [hash, now, expiresAt],
  );
  return rows[0].account_id;
}

/** Destroy a session (logout). No-op if absent. */
export async function destroySession(id: string | null | undefined): Promise<void> {
  if (!id) return;
  const p = getPool();
  await p.query(`DELETE FROM portal_sessions WHERE session_hash=$1`, [hashSession(id)]);
}
