// scripts/migrate.mts
// Idempotent DB migration runner. Replaces raw `psql -f`.
//
//   npm run migrate        # apply all pending migrations
//   npm run migrate -- --dry   # print pending migrations, apply nothing
//   MIGRATE_DRY=1 npm run migrate
//
// Migrations live in scripts/migrations/*.sql and are applied in filename order
// (zero-padded numeric prefix). Each applied version is recorded in the
// schema_migrations table; running twice applies nothing the second time.
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pendingMigrations } from "./migrate-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

export { pendingMigrations };

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql"));
}

async function appliedVersions(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  return rows.map((r) => r.version);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry") || process.env.MIGRATE_DRY === "1";

  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("POSTGRES_URL is not set");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const allFiles = await listMigrationFiles();
    const applied = await appliedVersions(pool);
    const pending = pendingMigrations(allFiles, applied);

    if (dry) {
      if (pending.length === 0) {
        console.log("no pending migrations");
      } else {
        for (const version of pending) console.log(`pending ${version}`);
      }
      await pool.end();
      return;
    }

    const appliedSet = new Set(applied);
    for (const version of allFiles.slice().sort()) {
      if (appliedSet.has(version)) {
        console.log(`skip ${version}`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, version), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          version,
        ]);
        await client.query("COMMIT");
        console.log(`applied ${version}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`failed ${version}:`, err);
        client.release();
        await pool.end();
        process.exit(1);
      }
      client.release();
    }

    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

// Only run the side-effecting migration when invoked as a script, so the test
// can import `pendingMigrations` without connecting to a DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
