// src/index-indexer.ts
import "dotenv/config";
import cron from "node-cron";
import { runDeltaSync } from "./rag/indexer.js";
import { getStatus } from "./rag/storage.js";
import { summarizeStatus } from "./rag/status.js";
import { notify } from "./notify.js";

const CRON_EXPR = process.env.INDEXER_CRON ?? "0 * * * *";

async function tick(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runDeltaSync();
    console.log(
      `[${new Date().toISOString()}] [${label}] documents=${stats.documents} chunks=${stats.chunks} apiCalls=${stats.apiCalls} took=${Date.now() - start}ms`,
    );
    // Surface any source that is failing or stale (best-effort; never breaks the tick).
    try {
      const sources = summarizeStatus(await getStatus());
      for (const s of sources.filter((x) => !x.ok || x.stale)) {
        const msg = `[ALERT] ${s.worker}/${s.source} ${s.ok ? "STALE" : "FAILING"}: age=${s.age_seconds}s last_error=${s.error ?? "-"}`;
        console.error(msg);
        await notify(msg, { title: "Zinom brain", priority: "high" });
      }
    } catch (e) {
      console.warn(`[status] alert check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    const msg = `[${new Date().toISOString()}] [${label}] FAILED: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg, err);
    await notify(msg, { title: "Zinom brain", priority: "high" });
  }
}

console.log(`brain-indexer starting; cron: ${CRON_EXPR}`);
console.log("running initial tick on startup...");
void tick("initial");

cron.schedule(CRON_EXPR, () => {
  void tick("cron");
});
