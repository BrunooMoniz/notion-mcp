// src/portal/mcp-tokens.ts
// List and revoke per-account MCP bearer tokens (account_api_tokens table).
// Token hashes are safe to expose as IDs — they are one-way SHA-256 of the
// plaintext token and carry no secret material. The plaintext is shown only once
// at issue time (POST /portal/mcp-token). Isolation: every write is gated on
// account_id from the session, never from request input.
import { getPool } from "../rag/storage.js";

export interface McpTokenSummary {
  id: string;            // token_hash — safe to expose
  name: string | null;   // label stored at issue time (e.g. "portal", "claude-code")
  created_at: string;    // ISO-8601
  last_used_at: string | null;
}

/** List all MCP tokens for a given account. Returns [] when none exist. */
export async function listMcpTokens(accountId: string): Promise<McpTokenSummary[]> {
  const p = getPool();
  const { rows } = await p.query<{
    token_hash: string;
    label: string | null;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT token_hash, label, created_at, last_used_at
     FROM account_api_tokens
     WHERE account_id=$1
     ORDER BY created_at DESC`,
    [accountId],
  );
  return rows.map((r) => ({
    id: r.token_hash,
    name: r.label,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    last_used_at:
      r.last_used_at instanceof Date
        ? r.last_used_at.toISOString()
        : r.last_used_at != null
          ? String(r.last_used_at)
          : null,
  }));
}

/** Revoke ONE token by hash, scoped to the session account.
 *  Returns true if a row was deleted; false if none matched (id unknown or
 *  belongs to a different account — caller should treat both as 404). */
export async function revokeMcpToken(accountId: string, tokenHash: string): Promise<boolean> {
  const p = getPool();
  const res = await p.query(
    `DELETE FROM account_api_tokens WHERE account_id=$1 AND token_hash=$2`,
    [accountId, tokenHash],
  );
  return (res.rowCount ?? 0) > 0;
}
