// scripts/reindex-all.mts
import "dotenv/config";
import { runDeltaSync } from "../src/rag/indexer.js";
import { brainSearch } from "../src/rag/search.js";
import { closePool } from "../src/rag/storage.js";

async function main() {
  console.log("=== Full reindex (personal workspace) ===");
  const stats = await runDeltaSync({ fullReindex: true });
  console.log(JSON.stringify(stats, null, 2));

  console.log("\n=== Smoke queries ===");
  for (const q of ["Talos", "stablecoin BRS", "Pinheiro Neto stock options", "fechamento semanal"]) {
    const hits = await brainSearch(q, { topK: 3, mode: "hybrid" });
    console.log(`\nQuery: "${q}"`);
    hits.forEach((h, i) =>
      console.log(
        `  ${i + 1}. score=${h.score.toFixed(4)} db=${h.chunk.db_name} url=${h.chunk.parent_url}\n     "${h.chunk.text.slice(0, 120).replace(/\n/g, " ")}..."`,
      ),
    );
  }
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
