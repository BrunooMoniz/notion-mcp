// src/billing/resync-cron.ts
// Per-account auto re-sync (the "frescor" plan lever). Free accounts re-index
// only manually (portal button); paid plans get a cadence (syncIntervalHours).
// This is the ONLY background loop that fans out over accounts; it reuses the
// event-driven indexAccount() as the per-account entry point.
import { getPool } from "../rag/storage.js";
import { getPlanLimits } from "./plans.js";

interface AccountAge { id: string; plan: string; last_run: Date | null }

/** Active friend accounts + their most-recent indexer run time. */
async function activeAccountAges(): Promise<AccountAge[]> {
  const p = getPool();
  const { rows } = await p.query<AccountAge>(
    `SELECT a.id, a.plan,
            (SELECT max(ended_at) FROM status_runs s
              WHERE s.account_id = a.id AND s.worker = 'indexer') AS last_run
       FROM account a
      WHERE a.status = 'active' AND a.kind = 'friend'`,
  );
  return rows;
}

/** Account ids whose plan has an auto-resync interval and whose last run is older
 *  than that interval (or never ran). Free (syncIntervalHours = null) is skipped. */
export async function dueAccounts(now: Date = new Date()): Promise<string[]> {
  const ages = await activeAccountAges();
  const due: string[] = [];
  for (const a of ages) {
    const interval = getPlanLimits(a.plan).syncIntervalHours;
    if (interval == null) continue; // free / manual only
    if (a.last_run == null) { due.push(a.id); continue; }
    const ageHours = (now.getTime() - new Date(a.last_run).getTime()) / 3600_000;
    if (ageHours >= interval) due.push(a.id);
  }
  return due;
}

/** Re-index every due account sequentially (cheap fan-out; one VPS). The indexer
 *  is injected for tests; defaults to the real per-account indexAccount. */
export async function runResyncTick(
  now: Date = new Date(),
  indexFn?: (accountId: string) => Promise<unknown>,
): Promise<{ ran: string[] }> {
  const fn = indexFn ?? (async (id: string) => {
    const { indexAccount } = await import("../rag/index-account.js");
    return indexAccount(id);
  });
  const due = await dueAccounts(now);
  const ran: string[] = [];
  for (const id of due) {
    try {
      await fn(id);
      ran.push(id);
    } catch (err: any) {
      console.error(`[resync] account=${id} failed: ${err?.message ?? err}`);
    }
  }
  if (ran.length) console.log(`[resync] re-indexed ${ran.length} account(s): ${ran.join(", ")}`);
  return { ran };
}
