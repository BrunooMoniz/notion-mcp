// src/portal/notion-workspaces.ts
// Multi-Notion portal lifecycle. The multi-tenant backend already supports N
// Notion workspaces per account (account_workspaces composite PK; per-workspace
// vault secrets notion_access/notion_refresh/notion_pat:<ws>). This module is the
// user-facing list/remove layer, mirroring the iCal add/remove pattern in
// sources.ts: list the connected workspaces (id + human name + connected date),
// and fully disconnect one (purge secrets + the workspace row + its indexed
// chunks). Account scope ALWAYS comes from the caller's session, NEVER input.
import { deleteAccountSecret } from "../secrets.js";
import { getPool, deleteByAccountWorkspaceSource } from "../rag/storage.js";

export interface NotionWorkspaceEntry {
  workspace: string; // the Notion workspace id (opaque UUID)
  name: string | null; // human-readable display name, persisted at connect time
  connected_at: string | null; // ISO
}

/** The per-workspace vault secret kinds a Notion connection owns. Removing a
 *  workspace deletes all three (only the relevant ones exist for a given path:
 *  OAuth -> access/refresh, PAT -> pat). */
export const NOTION_SECRET_KINDS = (workspace: string): string[] => [
  `notion_access:${workspace}`,
  `notion_refresh:${workspace}`,
  `notion_pat:${workspace}`,
];

/** List the Notion workspaces connected to an account, newest first, with the
 *  display name (0010) and connect date for the portal. */
export async function listNotionWorkspaces(accountId: string): Promise<NotionWorkspaceEntry[]> {
  const p = getPool();
  const { rows } = await p.query<{ workspace: string; name: string | null; created_at: Date | string | null }>(
    `SELECT workspace, name, created_at FROM account_workspaces
     WHERE account_id=$1 ORDER BY created_at DESC NULLS LAST, workspace`,
    [accountId],
  );
  return rows.map((r) => ({
    workspace: r.workspace,
    name: r.name ?? null,
    connected_at: r.created_at == null ? null : new Date(r.created_at).toISOString(),
  }));
}

/** True iff (accountId, workspace) is a registered workspace of THIS account.
 *  The isolation gate: a disconnect must verify ownership before deleting. */
export async function accountOwnsWorkspace(accountId: string, workspace: string): Promise<boolean> {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT 1 FROM account_workspaces WHERE account_id=$1 AND workspace=$2 LIMIT 1`,
    [accountId, workspace],
  );
  return rows.length > 0;
}

/**
 * Fully disconnect ONE Notion workspace from an account. Returns false if the
 * workspace doesn't belong to this account (isolation: never act on input the
 * session doesn't own). On success it:
 *   1. deletes the workspace's Notion secrets (access / refresh / pat),
 *   2. removes the account_workspaces row for (accountId, workspace),
 *   3. purges that workspace's indexed Notion chunks (account+workspace scoped).
 * The plan workspace cap (assertCanAddWorkspace) is unaffected — this only frees
 * a slot, it does not change the cap.
 */
export async function disconnectNotionWorkspace(
  accountId: string,
  workspace: string,
): Promise<boolean> {
  if (!(await accountOwnsWorkspace(accountId, workspace))) return false;

  // 1. Vault secrets (no-op for kinds that don't exist for this connection).
  for (const kind of NOTION_SECRET_KINDS(workspace)) {
    await deleteAccountSecret(accountId, kind);
  }

  // 2. The workspace registration row (drops it from the bearer scope + the list).
  const p = getPool();
  await p.query(
    `DELETE FROM account_workspaces WHERE account_id=$1 AND workspace=$2`,
    [accountId, workspace],
  );

  // 3. Indexed Notion chunks for this exact (account, workspace) — never another's.
  await deleteByAccountWorkspaceSource(accountId, workspace, "notion");

  return true;
}
