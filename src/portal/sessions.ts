// src/portal/sessions.ts
// 002-app-v2 — "Sessões ativas": list and revoke the account's portal sessions.
// The session_hash is safe to expose as an id (SHA-256 of the cookie value —
// it can never be replayed as a cookie). Isolation: every read/write is gated
// on account_id from the SESSION, never from request input; revoking another
// account's session hash is a no-op (caller maps to 404).
import { getPool } from "../rag/storage.js";

export interface PortalSessionSummary {
  id: string;          // session_hash — safe to expose
  current: boolean;    // is this the session making the request?
  created_at: string;  // ISO-8601
  last_seen_at: string | null;
  user_agent: string | null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** List the account's non-expired sessions, newest activity first.
 *  `currentHash` is the hash of the requesting session (flags `current`). */
export async function listSessions(
  accountId: string,
  currentHash: string,
  now: Date = new Date(),
): Promise<PortalSessionSummary[]> {
  const p = getPool();
  const { rows } = await p.query<{
    session_hash: string;
    created_at: Date;
    last_seen_at: Date | null;
    user_agent: string | null;
  }>(
    `SELECT session_hash, created_at, last_seen_at, user_agent
       FROM portal_sessions
      WHERE account_id = $1 AND expires_at > $2
      ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`,
    [accountId, now],
  );
  return rows.map((r) => ({
    id: r.session_hash,
    current: r.session_hash === currentHash,
    created_at: toIso(r.created_at) as string,
    last_seen_at: toIso(r.last_seen_at),
    user_agent: r.user_agent,
  }));
}

/** Revoke ONE session by hash, scoped to the account. Returns true if a row
 *  was deleted; false if unknown or owned by another account (caller → 404). */
export async function revokeSession(accountId: string, sessionHash: string): Promise<boolean> {
  const p = getPool();
  const res = await p.query(
    `DELETE FROM portal_sessions WHERE account_id=$1 AND session_hash=$2`,
    [accountId, sessionHash],
  );
  return (res.rowCount ?? 0) > 0;
}
