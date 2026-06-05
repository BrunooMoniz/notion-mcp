// src/rag/usage.ts
// F3.0 — passive usage metering (NO enforcement yet; free-tier limits land in
// F3.3). Append-only to usage_log, best-effort: like recordRun, a metering
// failure must never break the real path, so it swallows errors. Skipped
// entirely when METERING_ENABLED=false.
import { getPool, hasInjectedPool } from "./storage.js";

export async function recordUsage(
  accountId: string,
  metric: string,
  qty: number,
): Promise<void> {
  if (process.env.METERING_ENABLED === "false") return;
  // No-op when there's no real DB and no injected test pool (e.g. unit tests
  // that don't exercise metering) — avoids a pointless failed connection.
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return;
  if (!Number.isFinite(qty) || qty <= 0) return;
  try {
    const p = getPool();
    await p.query(
      `INSERT INTO usage_log (account_id, metric, qty) VALUES ($1, $2, $3)`,
      [accountId, metric, Math.floor(qty)],
    );
  } catch (err: any) {
    console.warn(`[usage] recordUsage failed (metering only): ${err?.message ?? err}`);
  }
}
