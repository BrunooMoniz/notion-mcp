// src/index-indexer.ts
import "dotenv/config";
import cron from "node-cron";
import { runDeltaSync } from "./rag/indexer.js";

const CRON_EXPR = process.env.INDEXER_CRON ?? "0 * * * *";

async function tick(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runDeltaSync();
    console.log(
      `[${new Date().toISOString()}] [${label}] documents=${stats.documents} chunks=${stats.chunks} apiCalls=${stats.apiCalls} took=${Date.now() - start}ms`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${label}] FAILED`, err);
  }
}

console.log(`brain-indexer starting; cron: ${CRON_EXPR}`);
console.log("running initial tick on startup...");
void tick("initial");

cron.schedule(CRON_EXPR, () => {
  void tick("cron");
});
