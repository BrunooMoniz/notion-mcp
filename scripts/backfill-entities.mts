// scripts/backfill-entities.mts
// E4 Phase 1 — standalone backfill for entity extraction.
// Run manually: ENTITIES_ENABLED=true npx tsx scripts/backfill-entities.mts [--account=<id>]
// Cursor persisted to .backfill-cursor for resumability.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CURSOR_FILE = ".backfill-cursor";
const BATCH_SIZE = parseInt(process.env.ENTITIES_BATCH_SIZE ?? "200", 10);
const SLEEP_MS = 200;

if (process.env.ENTITIES_ENABLED !== "true") {
  console.error("ERROR: Set ENTITIES_ENABLED=true before running this script.");
  process.exit(1);
}

// Parse --account arg
const accountArg = process.argv.find((a) => a.startsWith("--account="));
const targetAccount = accountArg ? accountArg.split("=")[1] : null;

const { getPool, closePool } = await import("../src/rag/storage.js");
const { extractEntitiesForAccount } = await import("../src/rag/entity-extractor.js");

const pool = getPool();

// Load cursor (lastOffset per account)
let cursor: Record<string, number> = {};
if (existsSync(CURSOR_FILE)) {
  try { cursor = JSON.parse(readFileSync(CURSOR_FILE, "utf8")); } catch { /* start fresh */ }
}

function saveCursor() {
  writeFileSync(CURSOR_FILE, JSON.stringify(cursor));
}

// Get accounts to process
const { rows: accounts } = await pool.query<{ id: string }>(
  targetAccount
    ? `SELECT id FROM account WHERE id = $1`
    : `SELECT id FROM account ORDER BY id`,
  targetAccount ? [targetAccount] : [],
);

if (accounts.length === 0) {
  console.log("No accounts found. Exiting.");
  await closePool();
  process.exit(0);
}

console.log(`Backfilling entities for ${accounts.length} account(s) — batch size ${BATCH_SIZE}`);

for (const { id: accountId } of accounts) {
  console.log(`\n[${accountId}] Starting...`);
  let totalChunks = 0;
  let totalErrors = 0;
  let iteration = 0;

  while (true) {
    const stats = await extractEntitiesForAccount(accountId);
    totalChunks += stats.chunksProcessed;
    totalErrors += stats.errors;
    iteration++;
    cursor[accountId] = iteration;
    saveCursor();

    console.log(
      `[${accountId}] batch ${iteration}: chunks=${stats.chunksProcessed} errors=${stats.errors}`,
    );

    if (stats.chunksProcessed === 0) {
      console.log(`[${accountId}] Done. Total: chunks=${totalChunks} errors=${totalErrors}`);
      break;
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }
}

await closePool();
console.log("\nBackfill complete.");
