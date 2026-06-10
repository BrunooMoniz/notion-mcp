// scripts/backfill-workspace-names.mts
// 1.2 — One-time backfill: resolve and persist the human-readable workspace name
// for every account_workspaces row that currently has name=NULL.
//
// For each (account_id, workspace) pair with name=NULL:
//   - If a notion_pat:<workspace> secret exists  → call /v1/users/me with that token
//   - If a notion_access:<workspace> secret exists → call /v1/users/me with that token
//   - If neither exists, skip (nothing we can do)
//
// Safe to run multiple times (idempotent — only touches rows where name IS NULL).
// Usage: SECRETS_KEY=... POSTGRES_URL=... npx tsx scripts/backfill-workspace-names.mts [--dry]
import "dotenv/config";
import { getPool, closePool } from "../src/rag/storage.js";
import { getAccountSecret } from "../src/secrets.js";
import { resolveWorkspaceName } from "../src/portal/workspace-name-resolver.js";

const DRY = process.argv.includes("--dry");

async function main(): Promise<void> {
  const p = getPool();

  // Find all workspace rows that still lack a human name.
  const { rows } = await p.query<{ account_id: string; workspace: string }>(
    `SELECT account_id, workspace FROM account_workspaces WHERE name IS NULL ORDER BY account_id, workspace`,
  );

  console.log(`[backfill] ${rows.length} workspace(s) with name=NULL${DRY ? " (dry run)" : ""}`);
  if (rows.length === 0) {
    console.log("[backfill] Nothing to do.");
    return;
  }

  let resolved = 0;
  let skipped = 0;

  for (const row of rows) {
    const { account_id, workspace } = row;

    // Try PAT first, then OAuth access token.
    let token: string | null = null;
    token = await getAccountSecret(account_id, `notion_pat:${workspace}`);
    if (!token) token = await getAccountSecret(account_id, `notion_access:${workspace}`);

    if (!token) {
      console.log(`[backfill] ${account_id}/${workspace}: no token found — skip`);
      skipped++;
      continue;
    }

    const name = await resolveWorkspaceName(token);

    if (!name) {
      console.log(`[backfill] ${account_id}/${workspace}: could not resolve name (token may be expired) — skip`);
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`[backfill] [DRY] ${account_id}/${workspace}: would set name="${name}"`);
    } else {
      await p.query(
        `UPDATE account_workspaces SET name=$3 WHERE account_id=$1 AND workspace=$2 AND name IS NULL`,
        [account_id, workspace, name],
      );
      console.log(`[backfill] ${account_id}/${workspace}: name="${name}" ✓`);
    }
    resolved++;
  }

  console.log(`[backfill] done — resolved: ${resolved}, skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  })
  .finally(() => closePool());
