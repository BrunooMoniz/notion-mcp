// scripts/doctor.mts — `npm run doctor`
// One command that validates every moving part of the brain and prints a
// green/red report. Catches the failures that used to be silent: an invalid
// Notion token that indexes 0, a calendar feed that stopped, a missing
// extension/migration, a dead Voyage key. Exits non-zero if anything is RED.
//
// Reuses the real clients/config so it tests exactly what the indexer uses.
import "dotenv/config";
import ical from "node-ical";
import { getPool } from "../src/rag/storage.js";
import { embedQuery } from "../src/rag/embeddings.js";
import { parseIcsConfig } from "../src/rag/calendar-ics-source.js";
// NOTE: src/clients.ts validates all NOTION_* tokens at import and throws if one
// is missing — so it's imported DYNAMICALLY inside the Notion check below, where a
// failure is reported (not allowed to crash the whole doctor).
import { hasCreds as hasGoogleCreds } from "../src/google/oauth.js";

type Level = "ok" | "warn" | "fail";
interface Check {
  name: string;
  level: Level;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, level: Level, detail = "") => checks.push({ name, level, detail });

async function timed<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

// --- env presence ---
for (const [k, required] of [
  ["POSTGRES_URL", true],
  ["VOYAGE_API_KEY", true],
  ["OAUTH_PASSWORD_HASH", false],
  ["BEARER_TOKEN", false],
] as const) {
  if (process.env[k]) add(`env ${k}`, "ok", "set");
  else add(`env ${k}`, required ? "fail" : "warn", "missing");
}

// --- Postgres: connectivity, extensions, tables, pending migrations ---
if (process.env.POSTGRES_URL) {
  try {
    const p = getPool();
    await timed(() => p.query("SELECT 1"));
    add("postgres connect", "ok", process.env.POSTGRES_URL.replace(/:\/\/[^@]*@/, "://***@"));

    const ext = await p.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector','unaccent','pg_trgm')`,
    );
    const have = new Set(ext.rows.map((r) => r.extname));
    for (const e of ["vector", "unaccent", "pg_trgm"]) {
      add(`extension ${e}`, have.has(e) ? "ok" : "fail", have.has(e) ? "" : "not installed");
    }

    const tbl = await p.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename IN ('brain_chunks','sync_state','embedding_cache','status_runs','schema_migrations')`,
    );
    const tables = new Set(tbl.rows.map((r) => r.tablename));
    for (const t of ["brain_chunks", "sync_state", "embedding_cache", "status_runs"]) {
      add(`table ${t}`, tables.has(t) ? "ok" : "fail", tables.has(t) ? "" : "missing — run `npm run migrate`");
    }

    if (tables.has("brain_chunks")) {
      const c = await p.query<{ source_type: string; n: string }>(
        `SELECT source_type, count(*)::text n FROM brain_chunks GROUP BY 1 ORDER BY 2 DESC`,
      );
      add("brain_chunks", "ok", c.rows.map((r) => `${r.source_type}=${r.n}`).join(" ") || "empty");
    }
  } catch (err) {
    add("postgres connect", "fail", err instanceof Error ? err.message : String(err));
  }
}

// --- Voyage embeddings ---
if (process.env.VOYAGE_API_KEY) {
  try {
    const v = await timed(() => embedQuery("teste de saúde do cérebro"));
    add("voyage embeddings", v.length > 0 ? "ok" : "fail", `dim=${v.length}`);
  } catch (err) {
    add("voyage embeddings", "fail", err instanceof Error ? err.message : String(err));
  }
}

// --- Notion tokens (per workspace) — catches an invalid PAT that silently indexes 0 ---
// Direct fetch to /v1/users/me (NOT via src/clients.ts, which process.exit(1)s on a
// missing token — a diagnostic must never be killed by the thing it diagnoses).
const NOTION_VERSION = "2025-09-03";
for (const ws of ["globalcripto", "personal", "nora"] as const) {
  const token = process.env[`NOTION_${ws.toUpperCase()}_TOKEN`];
  if (!token) {
    add(`notion ${ws}`, "warn", "token not set");
    continue;
  }
  try {
    const r = await fetch("https://api.notion.com/v1/users/me", {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    });
    if (r.ok) {
      const me = (await r.json()) as { bot?: { owner?: { type?: string } }; name?: string };
      add(`notion ${ws}`, "ok", `token valid (${me?.name ?? me?.bot?.owner?.type ?? "bot"})`);
    } else {
      add(`notion ${ws}`, "fail", `HTTP ${r.status} ${(await r.text()).slice(0, 100)}`);
    }
  } catch (err) {
    add(`notion ${ws}`, "fail", err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
}

// --- iCal calendars ---
const icsCals = parseIcsConfig();
if (icsCals.length === 0) {
  add("calendars (iCal)", "warn", "GOOGLE_CAL_ICS not set");
} else {
  for (const cal of icsCals) {
    try {
      const data = (await ical.async.fromURL(cal.url)) as Record<string, { type?: string }>;
      const n = Object.values(data).filter((e) => e.type === "VEVENT").length;
      add(`calendar ${cal.label}`, n > 0 ? "ok" : "warn", `${n} events (${cal.workspace})`);
    } catch (err) {
      add(`calendar ${cal.label}`, "fail", err instanceof Error ? err.message.slice(0, 120) : String(err));
    }
  }
}

// --- Google OAuth fallback (info only; iCal is preferred) ---
add("google oauth creds", hasGoogleCreds() ? "ok" : "warn", hasGoogleCreds() ? "present" : "absent (iCal preferred)");

// --- report ---
const icon = { ok: "✅", warn: "🟡", fail: "🔴" } as const;
const pad = Math.max(...checks.map((c) => c.name.length));
console.log("\nBrain doctor\n============");
for (const c of checks) {
  console.log(`${icon[c.level]} ${c.name.padEnd(pad)}  ${c.detail}`);
}
const fails = checks.filter((c) => c.level === "fail").length;
const warns = checks.filter((c) => c.level === "warn").length;
console.log(`\n${checks.length} checks — ${fails} red, ${warns} yellow, ${checks.length - fails - warns} green`);

try {
  await getPool().end();
} catch {
  /* ignore */
}
process.exitCode = fails > 0 ? 1 : 0;
