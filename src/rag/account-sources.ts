// src/rag/account-sources.ts
// 001-account-portal — small, clients.ts-free helpers for per-account Granola/iCal
// indexing, split out of index-account.ts so they stay unit-testable (importing
// index-account.ts boots notion-source -> clients.ts, which process.exit()s
// without NOTION_* env).
import { getPool } from "./storage.js";
import { VALID_WORKSPACES, type IcsCalendarConfig } from "./calendar-ics-source.js";
import type { Workspace } from "./types.js";

/** Coerce a friend-supplied workspace to the known enum, defaulting otherwise, so
 *  an arbitrary string never reaches account_workspaces (the bearer-scope table)
 *  or gets tagged on chunks. */
export function coerceWorkspace(ws: unknown): Workspace {
  return typeof ws === "string" && (VALID_WORKSPACES as string[]).includes(ws)
    ? (ws as Workspace)
    : FRIEND_WORKSPACE;
}

// A friend has one Granola key and many iCal links, all conceptually their own
// single space. Tag them with this workspace AND register it in account_workspaces
// so the friend's per-account bearer (scoped to its workspaces) can see these
// chunks. account_id still does the real isolation; the workspace tag is the
// defense-in-depth scope.
export const FRIEND_WORKSPACE: Workspace = "personal";

/** Map a friend's vault-stored iCal blob (JSON array) to source configs. Pure.
 *  Bad/empty input yields []. */
export function accountIcalConfigs(raw: string | null): IcsCalendarConfig[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: IcsCalendarConfig[] = [];
  for (const e of arr as Array<Record<string, unknown>>) {
    if (typeof e?.url === "string" && e.url) {
      out.push({
        url: e.url,
        label: typeof e.label === "string" && e.label ? e.label : "Calendário",
        workspace: coerceWorkspace(e.workspace),
      });
    }
  }
  return out;
}

/** Register a workspace for an account (idempotent) so its bearer scope includes
 *  it. */
export async function ensureAccountWorkspace(accountId: string, workspace: string): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO account_workspaces (account_id, workspace) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [accountId, workspace],
  );
}
