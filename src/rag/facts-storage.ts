// src/rag/facts-storage.ts
// F2.3 — thin DB layer for the temporal-facts table (brain_facts, 0004). Mirrors
// the patterns in storage.ts: reuses getPool() (so __setPoolForTest works for
// both), keeps every value parameterized (no string interpolation of inputs),
// and is intentionally small (kept out of storage.ts to avoid bloat).
import { getPool } from "./storage.js";
import type { Fact } from "./facts.js";

/**
 * Bulk-insert facts. Returns the number of rows inserted. No-op (returns 0) on
 * an empty array. A single multi-row INSERT keeps it one round-trip; every
 * value is parameterized.
 */
export async function insertFacts(facts: Fact[]): Promise<number> {
  if (facts.length === 0) return 0;
  const p = getPool();

  const cols = [
    "subject",
    "predicate",
    "object",
    "workspace",
    "source_id",
    "source_type",
    "confidence",
    "valid_from",
    "valid_to",
    "metadata",
  ];
  const perRow = cols.length;
  const params: unknown[] = [];
  const rowPlaceholders: string[] = [];

  facts.forEach((f, idx) => {
    const base = idx * perRow;
    rowPlaceholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}::date, $${base + 9}::date, $${base + 10}::jsonb)`,
    );
    params.push(
      f.subject,
      f.predicate,
      f.object,
      f.workspace,
      f.source_id,
      f.source_type,
      f.confidence,
      f.valid_from,
      f.valid_to,
      f.metadata === undefined ? null : JSON.stringify(f.metadata),
    );
  });

  const sql = `INSERT INTO brain_facts (${cols.join(", ")}) VALUES ${rowPlaceholders.join(", ")}`;
  const res = await p.query(sql, params);
  return res.rowCount ?? facts.length;
}

export interface QueryFactsOpts {
  subject?: string;
  predicate?: string;
  workspace?: string;
  activeOn?: string; // ISO YYYY-MM-DD: fact must be valid on this date
  limit?: number;
}

interface FactRow {
  subject: string;
  predicate: string;
  object: string;
  workspace: string | null;
  source_id: string | null;
  source_type: string | null;
  confidence: number | null;
  valid_from: string | null;
  valid_to: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Query facts with parameterized filters:
 *   - subject / predicate  → case-insensitive equality (lower() match)
 *   - workspace            → equality
 *   - activeOn (a date)    → fact valid on that date:
 *       valid_from <= $ AND (valid_to IS NULL OR valid_to >= $)
 * Default limit 50. All values stay parameterized.
 */
export async function queryFacts(opts: QueryFactsOpts = {}): Promise<Fact[]> {
  const p = getPool();
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (opts.subject) {
    clauses.push(`lower(subject) = lower($${i++})`);
    params.push(opts.subject);
  }
  if (opts.predicate) {
    clauses.push(`lower(predicate) = lower($${i++})`);
    params.push(opts.predicate);
  }
  if (opts.workspace) {
    clauses.push(`workspace = $${i++}`);
    params.push(opts.workspace);
  }
  if (opts.activeOn) {
    // The fact's validity window must contain the given date. A null valid_from
    // means "unknown start" — treat it as not excluding (only filter when set).
    const n = i++;
    clauses.push(
      `(valid_from IS NULL OR valid_from <= $${n}::date) AND (valid_to IS NULL OR valid_to >= $${n}::date)`,
    );
    params.push(opts.activeOn);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  params.push(limit);
  const sql =
    `SELECT subject, predicate, object, workspace, source_id, source_type, ` +
    `confidence, valid_from, valid_to, metadata ` +
    `FROM brain_facts ${where} ORDER BY extracted_at DESC LIMIT $${i}`;

  const { rows } = await p.query<FactRow>(sql, params);
  return rows.map((r) => ({
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    workspace: r.workspace,
    source_id: r.source_id,
    source_type: r.source_type,
    confidence: r.confidence,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    ...(r.metadata ? { metadata: r.metadata } : {}),
  }));
}
