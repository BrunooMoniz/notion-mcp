// src/portal/week.ts
// 002-app-v2 — "Sua semana" card: what landed in the account's brain in the
// last 7 days. Pure SQL over brain_chunks (no Voyage, no search quota), always
// scoped by account_id (the caller passes the SESSION account, never input).
// "documents" counts distinct source_id indexed in the window; "meetings" is
// the granola slice of that; "recent" lists the latest ≤6 documents.
import { getPool, titleFromHeaderLine } from "../rag/storage.js";

export interface WeekSummary {
  documents: number;
  meetings: number;
  by_source: { source_type: string; count: number }[];
  recent: { title: string; source_type: string; indexed_at: string }[];
}

const WINDOW_DAYS = 7;
const RECENT_LIMIT = 6;

export async function getWeekSummary(accountId: string): Promise<WeekSummary> {
  const p = getPool();

  // Per-source distinct-document counts within the window.
  const { rows: bySourceRows } = await p.query<{ source_type: string; count: string }>(
    `SELECT source_type, COUNT(DISTINCT source_id) AS count
       FROM brain_chunks
      WHERE account_id = $1 AND indexed_at >= now() - ($2 || ' days')::interval
      GROUP BY source_type
      ORDER BY count DESC, source_type`,
    [accountId, String(WINDOW_DAYS)],
  );
  const by_source = bySourceRows.map((r) => ({
    source_type: r.source_type,
    count: Number(r.count),
  }));
  const documents = by_source.reduce((a, s) => a + s.count, 0);
  const meetings = by_source.find((s) => s.source_type === "granola")?.count ?? 0;

  // Latest documents (one row per source_id; title recovered from the chunk's
  // provenance header — same trick as listBrainDocuments).
  const { rows: recentRows } = await p.query<{
    source_type: string;
    first_line: string | null;
    indexed_at: Date;
  }>(
    `SELECT source_type, first_line, indexed_at
       FROM (
         SELECT DISTINCT ON (source_id)
           source_id, source_type,
           split_part(text, E'\n', 1) AS first_line,
           indexed_at
         FROM brain_chunks
         WHERE account_id = $1 AND indexed_at >= now() - ($2 || ' days')::interval
         ORDER BY source_id, chunk_index
       ) d
      ORDER BY indexed_at DESC
      LIMIT $3`,
    [accountId, String(WINDOW_DAYS), RECENT_LIMIT],
  );
  const recent = recentRows.map((r) => ({
    title: titleFromHeaderLine(r.first_line),
    source_type: r.source_type,
    indexed_at: r.indexed_at instanceof Date ? r.indexed_at.toISOString() : String(r.indexed_at),
  }));

  return { documents, meetings, by_source, recent };
}
