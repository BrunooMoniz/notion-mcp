// scripts/set-tasks-db.mts — 003-tasks-v1 ops helper: point an account's task
// tracker at a Notion data_source id (vault kind "tasks_db", encrypted).
// Usage: npm run set-tasks-db -- --account bruno --id 30d07ba5-bee8-8040-841b-000b5d0b5d84
// Needs: SECRETS_KEY + POSTGRES_URL (same env the server uses).
import "dotenv/config";
import { setTasksDbId } from "../src/portal/task-tracker.js";
import { closePool } from "../src/rag/storage.js";

function argValue(flag: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
}

const account = argValue("--account");
const id = argValue("--id");
if (!account || !id) {
  console.error("usage: npm run set-tasks-db -- --account <accountId> --id <data_source_id>");
  process.exit(1);
}

await setTasksDbId(account, id);
console.log(`tasks_db set for account=${account} → data_source=${id}`);
await closePool();
