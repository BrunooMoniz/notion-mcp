// src/portal/leads.ts
// 001-account-portal — invite-request leads. A visitor requests access from the
// landing; the operator sees them in /admin and generates + emails an invite.
import { getPool } from "../rag/storage.js";
import { normalizeEmail } from "./accounts.js";

export interface InviteRequest {
  id: number;
  email: string;
  name: string | null;
  note: string | null;
  status: string; // pending | invited
  requested_at: Date;
  invited_at: Date | null;
  dismissed_at: Date | null;
}

/** Record (or refresh) an invite request for an email. Idempotent per email. */
export async function createInviteRequest(email: string, name?: string, note?: string): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO invite_requests (email, name, note) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, invite_requests.name),
           note = COALESCE(EXCLUDED.note, invite_requests.note),
           requested_at = now()`,
    [normalizeEmail(email), name?.slice(0, 200) || null, note?.slice(0, 500) || null],
  );
}

/** Newest-first, with pending requests on top. */
export async function listInviteRequests(limit = 200): Promise<InviteRequest[]> {
  const p = getPool();
  const { rows } = await p.query<InviteRequest>(
    `SELECT id, email, name, note, status, requested_at, invited_at, dismissed_at
     FROM invite_requests
     ORDER BY (status = 'pending') DESC, requested_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Mark a request as invited, recording the issued code's hash (audit). Creates
 *  the row first if the email wasn't a lead (manual invite from /admin). */
export async function markRequestInvited(email: string, codeHash: string): Promise<void> {
  const e = normalizeEmail(email);
  const p = getPool();
  await p.query(
    `INSERT INTO invite_requests (email, status, invited_at, invite_code_hash)
     VALUES ($1, 'invited', now(), $2)
     ON CONFLICT (email) DO UPDATE
       SET status = 'invited', invited_at = now(), invite_code_hash = EXCLUDED.invite_code_hash`,
    [e, codeHash],
  );
}

export async function countPendingRequests(): Promise<number> {
  const p = getPool();
  const { rows } = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invite_requests WHERE status='pending'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Mark a lead as dismissed (operator chose not to invite them).
 * Sets dismissed_at=now() without changing the status column.
 * Idempotent: re-dismissing a lead is harmless.
 * Does NOT delete the lead (preserves audit history).
 */
export async function dismissInviteRequest(email: string): Promise<void> {
  const e = normalizeEmail(email);
  const p = getPool();
  await p.query(
    `UPDATE invite_requests SET dismissed_at = now() WHERE email = $1`,
    [e],
  );
}
