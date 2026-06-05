// src/rag/storage.ts
import pg from "pg";
import type { ChunkWithEmbedding, Chunk, SearchFilters } from "./types.js";
import { formatVector } from "./embeddings.js";
import type { StatusRow } from "./status.js";

let pool: pg.Pool | null = null;

/** Minimal pg-like surface the storage layer depends on (lets tests inject a stub). */
type PoolLike = Pick<pg.Pool, "query">;

let injectedPool: PoolLike | null = null;

/**
 * Test-only seam: inject a fake pool (or pass null to clear). Guarded so
 * production never touches it — `getPool()` only uses it when set by a test.
 */
export function __setPoolForTest(p: PoolLike | null): void {
  injectedPool = p;
}

/** True when a test pool is injected (used by best-effort writers to no-op in
 *  unit tests that have neither POSTGRES_URL nor an injected pool). */
export function hasInjectedPool(): boolean {
  return injectedPool !== null;
}

export function getPool(): pg.Pool {
  if (injectedPool) return injectedPool as pg.Pool;
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function upsertChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
  if (chunks.length === 0) return;
  const p = getPool();
  const sql = `
    INSERT INTO brain_chunks
      (id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
       text, embedding, metadata, source_updated, account_id, indexed_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb, $11, $12, now())
    ON CONFLICT (id) DO UPDATE SET
      source_type    = EXCLUDED.source_type,
      source_id      = EXCLUDED.source_id,
      workspace      = EXCLUDED.workspace,
      db_name        = EXCLUDED.db_name,
      parent_url     = EXCLUDED.parent_url,
      chunk_index    = EXCLUDED.chunk_index,
      text           = EXCLUDED.text,
      embedding      = EXCLUDED.embedding,
      metadata       = EXCLUDED.metadata,
      source_updated = EXCLUDED.source_updated,
      account_id     = EXCLUDED.account_id,
      indexed_at     = now()
  `;
  for (const c of chunks) {
    await p.query(sql, [
      c.id,
      c.source_type,
      c.source_id,
      c.workspace,
      c.db_name,
      c.parent_url,
      c.chunk_index,
      c.text,
      formatVector(c.embedding),
      JSON.stringify(c.metadata),
      c.source_updated,
      c.account_id ?? "bruno",
    ]);
  }
}

export async function deleteBySource(
  sourceType: string,
  sourceId: string,
  accountId = "bruno",
): Promise<void> {
  const p = getPool();
  await p.query(
    `DELETE FROM brain_chunks WHERE source_type=$1 AND source_id=$2 AND account_id=$3`,
    [sourceType, sourceId, accountId],
  );
}

/**
 * Delete chunks for a source that are no longer present upstream (orphans),
 * scoped to a single (source_type, workspace) namespace.
 *
 * `source_type` in brain_chunks is the BARE value (`notion`/`granola`/`calendar`),
 * distinct from the dashed sync_state keys (`granola-<ws>` / `calendar-google`).
 * Because granola/calendar chunks from different workspaces share the same bare
 * source_type, a workspace-less prune would delete another workspace's chunks —
 * so we REQUIRE the workspace argument for those sources.
 *
 * Returns the number of rows deleted.
 */
export async function pruneOrphans(
  sourceType: "notion" | "granola" | "calendar",
  workspace: string | null,
  liveIds: string[],
  accountId = "bruno",
): Promise<number> {
  if ((sourceType === "granola" || sourceType === "calendar") && !workspace) {
    throw new Error("workspace required for granola/calendar prune");
  }
  const p = getPool();
  // F3.0: account-scope the prune so a future second account's chunks of the
  // same source_type/workspace are never collateral-deleted.
  const params: unknown[] = [sourceType, accountId];
  let where = "source_type = $1 AND account_id = $2";
  if (workspace) {
    params.push(workspace);
    where += ` AND workspace = $${params.length}`;
  }
  params.push(liveIds);
  where += ` AND source_id <> ALL($${params.length})`;
  const res = await p.query(`DELETE FROM brain_chunks WHERE ${where}`, params);
  return res.rowCount ?? 0;
}

export async function getSyncState(sourceType: string, accountId = "bruno"): Promise<Date> {
  const p = getPool();
  const { rows } = await p.query<{ last_sync_at: Date }>(
    `SELECT last_sync_at FROM sync_state WHERE account_id=$1 AND source_type=$2`,
    [accountId, sourceType],
  );
  return rows[0]?.last_sync_at ?? new Date(0);
}

export async function setSyncState(sourceType: string, ts: Date, accountId = "bruno"): Promise<void> {
  const p = getPool();
  // F3.0: sync_state PK is now (account_id, source_type) — conflict target matches.
  await p.query(
    `INSERT INTO sync_state (account_id, source_type, last_sync_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, source_type) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at`,
    [accountId, sourceType, ts],
  );
}

// --- Observability: status_runs (0003) --------------------------------------
// recordRun appends one row per worker per source per run; getStatus returns
// the LATEST row per (worker, source) so a dead/stale source is never silent.

/**
 * Append a telemetry row for one worker/source run. BEST-EFFORT: never throws
 * into the caller — a failure to record status must not break a real indexer or
 * classifier run. On any error we console.warn and swallow.
 */
export async function recordRun(run: {
  worker: string;
  source: string;
  ok: boolean;
  counts?: unknown;
  error?: string | null;
  startedAt: Date;
  endedAt: Date;
  accountId?: string;
}): Promise<void> {
  try {
    const p = getPool();
    await p.query(
      `INSERT INTO status_runs (account_id, worker, source, ok, counts, error, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        run.accountId ?? "bruno",
        run.worker,
        run.source,
        run.ok,
        run.counts === undefined ? null : JSON.stringify(run.counts),
        run.error ?? null,
        run.startedAt,
        run.endedAt,
      ],
    );
  } catch (err: any) {
    console.warn(`[status] recordRun failed (telemetry only): ${err?.message ?? err}`);
  }
}

/**
 * Latest run per (worker, source), with age_seconds and a best-effort merge of
 * sync_state.last_sync_at. The status_runs.source uses bare keys ('calendar'),
 * while sync_state uses dashed keys ('calendar-google'); we normalize that one
 * mapping so the join lines up (other sources share the same key in both).
 * Returns raw rows; summarizeStatus() (pure, in status.ts) shapes the payload.
 */
export async function getStatus(): Promise<StatusRow[]> {
  const p = getPool();
  const { rows } = await p.query<{
    worker: string;
    source: string;
    ok: boolean;
    counts: unknown;
    error: string | null;
    last_run_at: Date;
    sync_last_at: Date | null;
  }>(
    `SELECT
       sr.worker,
       sr.source,
       sr.ok,
       sr.counts,
       sr.error,
       sr.ended_at AS last_run_at,
       ss.last_sync_at AS sync_last_at
     FROM (
       SELECT DISTINCT ON (worker, source)
         worker, source, ok, counts, error, ended_at
       FROM status_runs
       ORDER BY worker, source, ended_at DESC
     ) sr
     LEFT JOIN sync_state ss
       ON ss.source_type = CASE WHEN sr.source = 'calendar' THEN 'calendar-google' ELSE sr.source END
     ORDER BY sr.worker, sr.source`,
  );
  return rows.map((r) => ({
    worker: r.worker,
    source: r.source,
    ok: r.ok,
    counts: r.counts,
    error: r.error,
    last_run_at: r.last_run_at,
    sync_last_at: r.sync_last_at,
  }));
}

interface QueryRow {
  id: string;
  source_type: string;
  source_id: string;
  workspace: string | null;
  db_name: string | null;
  parent_url: string | null;
  chunk_index: number;
  text: string;
  metadata: Record<string, unknown>;
  source_updated: Date | null;
  score: number;
}

function rowToChunk(r: QueryRow): Chunk {
  return {
    id: r.id,
    source_type: r.source_type as Chunk["source_type"],
    source_id: r.source_id,
    workspace: r.workspace as Chunk["workspace"],
    db_name: r.db_name,
    parent_url: r.parent_url,
    chunk_index: r.chunk_index,
    text: r.text,
    metadata: r.metadata,
    source_updated: r.source_updated,
  };
}

/**
 * Build the dynamic WHERE fragment + ordered params for a SearchFilters object.
 *
 * `startIdx` is the 1-based index of the FIRST positional placeholder this
 * fragment should emit (callers that prepend their own params — e.g. the query
 * embedding + topK — pass the next free slot; pure tests omit it and get $1…).
 *
 * Exported so unit tests can assert the emitted SQL/params without a live DB.
 * All values stay parameterized (no string interpolation of user input).
 */
export function buildFilterClauses(
  filters: SearchFilters | undefined,
  startIdx = 1,
): { sql: string; params: unknown[] } {
  if (!filters) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  // F3.0 — hard tenant-scope guard. brainSearch threads `_accountId` from the
  // trusted request context (getAccountId), never from input. AND-ed with the
  // workspace guard below (defense in depth): even if one guard is misset, the
  // other still isolates. `undefined` = no account restriction (cron/eval/tests).
  if (filters._accountId !== undefined) {
    clauses.push(`account_id = $${i++}`);
    params.push(filters._accountId);
  }
  // F.4.2 — hard workspace-scope guard. When brainSearch threads an
  // _allowedWorkspaces list (from the OAuth scope, intersected with the caller's
  // requested workspace), restrict every query to those workspaces. An empty
  // array yields ANY('{}') -> zero rows, so a scoped token can never read
  // another workspace's chunks. `undefined` = no restriction (bearer/cron/eval).
  if (filters._allowedWorkspaces !== undefined) {
    clauses.push(`workspace = ANY($${i++})`);
    params.push(filters._allowedWorkspaces);
  }
  if (filters.workspace) {
    clauses.push(`workspace = $${i++}`);
    params.push(filters.workspace);
  }
  if (filters.db) {
    clauses.push(`db_name = $${i++}`);
    params.push(filters.db);
  }
  if (filters.frente) {
    clauses.push(`metadata->>'frente' = $${i++}`);
    params.push(filters.frente);
  }
  if (filters.source_type) {
    clauses.push(`source_type = $${i++}`);
    params.push(filters.source_type);
  }
  if (filters.exclude_source_type) {
    clauses.push(`source_type <> $${i++}`);
    params.push(filters.exclude_source_type);
  }
  // Date semantics: the effective date of a chunk is its own metadata.data
  // (Notion date prop / Granola created_at / Calendar start), falling back to
  // source_updated when unset. Rows whose COALESCE'd date is NULL (neither
  // present) are INCLUDED — we only emit a clause when a bound is given, so
  // "no date filter" never excludes anything.
  if (filters.date_from) {
    clauses.push(`COALESCE((metadata->>'data')::date, source_updated::date) >= $${i++}::date`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    clauses.push(`COALESCE((metadata->>'data')::date, source_updated::date) <= $${i++}::date`);
    params.push(filters.date_to);
  }
  if (filters.pessoa) {
    // Real per-source shapes: Notion writes metadata.pessoas (string[]),
    // Granola writes metadata.attendees (string[]). Match either, accent- and
    // case-insensitive, partial. `contatos` is dropped (no chunk populates it
    // yet — dead branch). Body fallback catches names that only appear inline.
    const n = i++;
    clauses.push(
      `(
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'pessoas','[]'::jsonb)) e
          WHERE unaccent(e) ILIKE unaccent('%' || $${n} || '%')
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'attendees','[]'::jsonb)) e
          WHERE unaccent(e) ILIKE unaccent('%' || $${n} || '%')
        )
        OR unaccent(text) ILIKE unaccent('%' || $${n} || '%')
      )`,
    );
    params.push(filters.pessoa);
  }
  return {
    sql: clauses.length ? "AND " + clauses.join(" AND ") : "",
    params,
  };
}

export async function searchSemantic(
  queryEmbedding: number[],
  filters: SearchFilters | undefined,
  topK: number,
): Promise<{ chunk: Chunk; rank: number; score: number }[]> {
  const p = getPool();
  const filterClauses = buildFilterClauses(filters, 3);
  const sql = `
    SELECT
      id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
      text, metadata, source_updated,
      1 - (embedding <=> $1::vector) AS score
    FROM brain_chunks
    WHERE embedding IS NOT NULL
      ${filterClauses.sql}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;
  const { rows } = await p.query<QueryRow>(sql, [
    formatVector(queryEmbedding),
    topK,
    ...filterClauses.params,
  ]);
  // Expose the real cosine similarity (1 - distance) instead of discarding it.
  return rows.map((r, idx) => ({ chunk: rowToChunk(r), rank: idx + 1, score: r.score }));
}

export async function searchKeyword(
  queryText: string,
  filters: SearchFilters | undefined,
  topK: number,
): Promise<{ chunk: Chunk; rank: number; score: number }[]> {
  const p = getPool();
  const filterClauses = buildFilterClauses(filters, 3);
  const sql = `
    SELECT
      id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
      text, metadata, source_updated,
      ts_rank(tsv, plainto_tsquery('portuguese', $1)) AS score
    FROM brain_chunks
    WHERE tsv @@ plainto_tsquery('portuguese', $1)
      ${filterClauses.sql}
    ORDER BY ts_rank(tsv, plainto_tsquery('portuguese', $1)) DESC
    LIMIT $2
  `;
  const { rows } = await p.query<QueryRow>(sql, [
    queryText,
    topK,
    ...filterClauses.params,
  ]);
  // Expose the real ts_rank score instead of discarding it.
  return rows.map((r, idx) => ({ chunk: rowToChunk(r), rank: idx + 1, score: r.score }));
}

export async function getNeighbors(sourceId: string, chunkIndex: number): Promise<Chunk[]> {
  const p = getPool();
  const { rows } = await p.query<QueryRow>(
    `SELECT id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
            text, metadata, source_updated
     FROM brain_chunks
     WHERE source_id=$1 AND chunk_index IN ($2, $3)
     ORDER BY chunk_index`,
    [sourceId, chunkIndex - 1, chunkIndex + 1],
  );
  return rows.map(rowToChunk);
}
