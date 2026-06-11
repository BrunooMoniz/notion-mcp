// src/rag/storage.ts
import pg from "pg";
import type { ChunkWithEmbedding, Chunk, SearchFilters } from "./types.js";
import { formatVector } from "./embeddings.js";
import type { StatusRow } from "./status.js";
import { getAccountId, DEFAULT_ACCOUNT_ID } from "../context.js";
import { recordUsage } from "./usage.js";

let pool: pg.Pool | null = null;

/** Minimal pg-like surface the storage layer depends on (lets tests inject a stub).
 *  `connect` is optional: only the transactional path (replaceDocumentChunks) uses
 *  it, and a real pg.Pool always provides it. */
type PoolLike = Pick<pg.Pool, "query"> & { connect?: pg.Pool["connect"] };

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

// Shared INSERT for a single chunk row (upsert by PK). Used by both upsertChunks
// (best-effort batch) and replaceDocumentChunks (transactional per-document).
const INSERT_CHUNK_SQL = `
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

function chunkInsertParams(c: ChunkWithEmbedding, fallbackAccountId: string): unknown[] {
  return [
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
    c.account_id ?? fallbackAccountId,
  ];
}

export async function upsertChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
  if (chunks.length === 0) return;
  const p = getPool();
  // Fase 3 billing — defensive chunk-storage cap. Owner/default account is
  // exempt (no DB hit). Lazy import to avoid the storage<->billing cycle (same
  // pattern as recordUsage). Throws QuotaExceededError when a friend would
  // exceed their plan's maxChunks; callers (on-demand tools) return a friendly
  // error. The per-account indexer path uses replaceDocumentChunks (capped too).
  const acctForCap = chunks[0]?.account_id ?? getAccountId();
  if (acctForCap !== DEFAULT_ACCOUNT_ID) {
    const { assertChunksWithinLimit } = await import("../billing/usage.js");
    await assertChunksWithinLimit(acctForCap, chunks.length);
  }
  for (const c of chunks) {
    await p.query(INSERT_CHUNK_SQL, chunkInsertParams(c, DEFAULT_ACCOUNT_ID));
  }
  // F3.0 passive metering: count chunks written for the current tenant.
  await recordUsage(getAccountId(), "chunks", chunks.length);
}

/**
 * Atomically REPLACE all chunks of ONE document (source_type+source_id) for an
 * account, inside a single transaction: DELETE the old chunks then INSERT the new
 * ones, commit-or-rollback as a unit.
 *
 * Why this exists: the per-account indexer used to delete every document's chunks
 * up front and only re-insert them in one batch at the very END of the pass. An
 * interruption (deploy/restart/OOM/network error mid-pass) between the deletes and
 * the final insert left the account's brain TOTALLY OR PARTIALLY EMPTY, with no
 * trace. Replacing one document at a time, transactionally, shrinks the only
 * possible loss window to a single in-flight document (recovered on the next
 * reindex) and never leaves the brain empty.
 *
 * ISOLATION: account_id scopes the DELETE and is forced onto every inserted row
 * (falling back to the passed accountId, NEVER to 'bruno'), so one account's
 * replace can never touch another's rows.
 */
export async function replaceDocumentChunks(
  sourceType: string,
  sourceId: string,
  accountId: string,
  chunks: ChunkWithEmbedding[],
): Promise<void> {
  const p = getPool();
  const deleteSql = `DELETE FROM brain_chunks WHERE source_type=$1 AND source_id=$2 AND account_id=$3`;
  const countSql = `SELECT count(*)::text AS n FROM brain_chunks WHERE account_id=$1`;

  // Fase 3 billing — chunk-storage cap on the per-account indexing path (portal
  // reindex, onboarding, auto re-sync). Owner/default exempt (cap = Infinity, no
  // query). The cap is checked against the POST-DELETE count of this same doc, so
  // re-indexing an existing document never false-blocks. Lazy import avoids the
  // storage<->billing cycle (same pattern as recordUsage). Throwing aborts the
  // transaction (rollback) and surfaces to the indexAccount pass / on-demand tool.
  let cap = Number.POSITIVE_INFINITY;
  let QuotaErr: (new (m: string, l: number, u: number) => Error) | null = null;
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    const billing = await import("../billing/usage.js");
    cap = await billing.chunkCapFor(accountId);
    QuotaErr = billing.QuotaExceededError;
  }
  const overCapAfter = async (current: number): Promise<void> => {
    if (cap !== Number.POSITIVE_INFINITY && current + chunks.length > cap && QuotaErr) {
      throw new QuotaErr("chunks indexados", cap, current);
    }
  };

  if (typeof p.connect === "function") {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      await client.query(deleteSql, [sourceType, sourceId, accountId]);
      if (cap !== Number.POSITIVE_INFINITY) {
        const { rows } = await client.query<{ n: string }>(countSql, [accountId]);
        await overCapAfter(Number(rows[0]?.n ?? 0));
      }
      for (const c of chunks) {
        await client.query(INSERT_CHUNK_SQL, chunkInsertParams(c, accountId));
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback failure; surface the original error */
      }
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Test stub without a real pool: sequential, non-transactional fallback.
    await p.query(deleteSql, [sourceType, sourceId, accountId]);
    if (cap !== Number.POSITIVE_INFINITY) {
      const { rows } = await p.query<{ n: string }>(countSql, [accountId]);
      await overCapAfter(Number(rows[0]?.n ?? 0));
    }
    for (const c of chunks) {
      await p.query(INSERT_CHUNK_SQL, chunkInsertParams(c, accountId));
    }
  }
  // F3.0 passive metering: count chunks written for the current tenant.
  await recordUsage(getAccountId(), "chunks", chunks.length);
}

export async function deleteBySource(
  sourceType: string,
  sourceId: string,
  accountId = DEFAULT_ACCOUNT_ID,
): Promise<void> {
  const p = getPool();
  await p.query(
    `DELETE FROM brain_chunks WHERE source_type=$1 AND source_id=$2 AND account_id=$3`,
    [sourceType, sourceId, accountId],
  );
}

/**
 * Purge EVERY chunk of one (source_type, workspace) namespace for an account.
 * Used when a friend disconnects a Notion workspace from the portal: all of that
 * workspace's indexed Notion chunks must vanish from their brain. ISOLATION:
 * account_id AND workspace both scope the DELETE, so removing one account's
 * workspace can never touch another account's rows (or another workspace's).
 * Returns the number of rows deleted.
 */
export async function deleteByAccountWorkspaceSource(
  accountId: string,
  workspace: string,
  sourceType: string,
): Promise<number> {
  const p = getPool();
  const res = await p.query(
    `DELETE FROM brain_chunks WHERE account_id=$1 AND workspace=$2 AND source_type=$3`,
    [accountId, workspace, sourceType],
  );
  return res.rowCount ?? 0;
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
  accountId = DEFAULT_ACCOUNT_ID,
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

export async function getSyncState(sourceType: string, accountId = DEFAULT_ACCOUNT_ID): Promise<Date> {
  const p = getPool();
  const { rows } = await p.query<{ last_sync_at: Date }>(
    `SELECT last_sync_at FROM sync_state WHERE account_id=$1 AND source_type=$2`,
    [accountId, sourceType],
  );
  return rows[0]?.last_sync_at ?? new Date(0);
}

export async function setSyncState(sourceType: string, ts: Date, accountId = DEFAULT_ACCOUNT_ID): Promise<void> {
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
        run.accountId ?? DEFAULT_ACCOUNT_ID,
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
export async function getStatus(accountId = DEFAULT_ACCOUNT_ID): Promise<StatusRow[]> {
  const p = getPool();
  // F3.0: scope to one account. The migration made sync_state PK (account_id,
  // source_type), so the join MUST also match on account_id — otherwise, once a
  // second account exists, one status_runs row would fan out across every
  // account's sync_state row (duplicate /status rows + wrong sync_last_at). At
  // N=1 (account 'bruno') this returns exactly the same rows as before.
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
       WHERE account_id = $1
       ORDER BY worker, source, ended_at DESC
     ) sr
     LEFT JOIN sync_state ss
       ON ss.account_id = $1
      AND ss.source_type = CASE WHEN sr.source = 'calendar' THEN 'calendar-google' ELSE sr.source END
     ORDER BY sr.worker, sr.source`,
    [accountId],
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

// Multi-tenant HNSW correctness: the index scan ranks candidates GLOBALLY
// (every account's vectors) and the account/workspace filter is applied
// post-scan. With several tenants holding near-duplicate content, the default
// ef_search (40) candidate set can be 100% other-tenant rows and the filtered
// result collapses to ZERO even though the account has thousands of chunks.
// Fix: raise ef_search per-query and enable pgvector >= 0.8 iterative scans
// (relaxed_order keeps fetching candidates until LIMIT survives the filter).
const HNSW_EF_SEARCH = Math.max(40, Number(process.env.HNSW_EF_SEARCH) || 200);

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
  const params = [formatVector(queryEmbedding), topK, ...filterClauses.params];

  let rows: QueryRow[];
  if (typeof (p as any).connect === "function") {
    // SET LOCAL needs a transaction pinned to one connection.
    const client = await (p as any).connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
      try {
        // pgvector >= 0.8 only; best-effort (older versions just keep ef_search).
        await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
      } catch {
        /* pgvector < 0.8: parameter does not exist */
      }
      rows = (await client.query(sql, params)).rows;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Injected test pools may not expose connect(); plain query keeps them working.
    rows = (await p.query<QueryRow>(sql, params)).rows;
  }

  // relaxed_order may yield slightly out-of-order rows — re-sort by similarity.
  rows.sort((a, b) => (b as any).score - (a as any).score);
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

export async function getNeighbors(
  sourceId: string,
  chunkIndex: number,
  accountId = DEFAULT_ACCOUNT_ID,
  workspace?: string | null,
): Promise<Chunk[]> {
  const p = getPool();
  // F3.0 (fix M1): account-scope neighbors — and workspace-scope them too — so
  // the neighbor expansion can never surface another tenant's (or another
  // workspace's) adjacent chunk that happens to share a source_id. The parent
  // hit was already account+workspace scoped by the search; neighbors match it.
  const params: unknown[] = [sourceId, chunkIndex - 1, chunkIndex + 1, accountId];
  let where = "source_id=$1 AND chunk_index IN ($2, $3) AND account_id=$4";
  if (workspace !== undefined) {
    params.push(workspace);
    where += ` AND workspace IS NOT DISTINCT FROM $${params.length}`;
  }
  const { rows } = await p.query<QueryRow>(
    `SELECT id, source_type, source_id, workspace, db_name, parent_url, chunk_index,
            text, metadata, source_updated
     FROM brain_chunks
     WHERE ${where}
     ORDER BY chunk_index`,
    params,
  );
  return rows.map(rowToChunk);
}

// --- WS3: per-account brain counts + document navigation --------------------
// Powers the portal "status do meu cérebro" card and the brain navigator. Both
// are account-scoped: callers (portal routes) pass the SESSION accountId; the
// WHERE always pins account_id, so one account can never read another's brain.

export interface BrainSourceCount {
  source_type: string;
  documents: number;
  chunks: number;
  last_indexed_at: Date | null;
}

/** Count indexed documents (distinct source_id) and chunks per source_type for
 *  ONE account, plus totals. Cheap aggregate over brain_chunks (uses the
 *  (account_id, workspace, db_name) index); no Voyage, no search quota. */
export async function getBrainCounts(
  accountId: string,
): Promise<{ bySource: BrainSourceCount[]; totals: { documents: number; chunks: number } }> {
  const p = getPool();
  const { rows } = await p.query<{
    source_type: string;
    documents: string;
    chunks: string;
    last_indexed_at: Date | null;
  }>(
    `SELECT source_type,
            COUNT(DISTINCT source_id) AS documents,
            COUNT(*)                  AS chunks,
            MAX(indexed_at)           AS last_indexed_at
       FROM brain_chunks
      WHERE account_id = $1
      GROUP BY source_type
      ORDER BY source_type`,
    [accountId],
  );
  const bySource = rows.map((r) => ({
    source_type: r.source_type,
    documents: Number(r.documents),
    chunks: Number(r.chunks),
    last_indexed_at: r.last_indexed_at,
  }));
  const totals = bySource.reduce(
    (a, s) => ({ documents: a.documents + s.documents, chunks: a.chunks + s.chunks }),
    { documents: 0, chunks: 0 },
  );
  return { bySource, totals };
}

export interface BrainDocument {
  source_id: string;
  source_type: string;
  db_name: string | null;
  workspace: string | null;
  parent_url: string | null;
  title: string;
  doc_date: string | null; // YYYY-MM-DD or null
}

/**
 * Recover a document title from a chunk's first line. Every chunk is stored with
 * a deterministic provenance header as its first line:
 *   `[db · workspace · YYYY-MM-DD · frente] Título`
 * (see context-header.ts). We strip the leading bracket to get the title; if
 * there is no bracket, the line IS the title. Exported for unit tests.
 */
export function titleFromHeaderLine(line: string | null | undefined): string {
  const raw = (line ?? "").trim();
  const stripped = raw.replace(/^\[[^\]]*\]\s*/, "").trim();
  return stripped || raw;
}

/**
 * List DISTINCT indexed documents (one row per source_id) for ONE account, for
 * the portal brain navigator. Optional source_type and a cheap ILIKE substring
 * filter (over the chunk text, which includes the header: title/db/workspace +
 * content). Paginated. Pure SQL — no Voyage, no search-quota usage. Newest first.
 *
 * Multi-entity filter:
 *   entityIds (number[]) + match ("all" | "any", default "all"):
 *     all  — documents whose mentions cover ALL of the selected entities
 *            (GROUP BY source_id HAVING count(distinct entity_id) = N)
 *     any  — documents that mention AT LEAST ONE of the selected entities
 *   entityId (single, legacy) — still supported; treated as entityIds=[n], match="all".
 *   When both entityIds and entityId are provided, entityIds takes precedence.
 */
export async function listBrainDocuments(
  accountId: string,
  opts: {
    sourceType?: string;
    q?: string;
    limit?: number;
    offset?: number;
    entityId?: number;           // legacy single-entity filter
    entityIds?: number[];        // multi-entity filter (overrides entityId when present)
    match?: "all" | "any";       // default "all"
  } = {},
): Promise<BrainDocument[]> {
  const p = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const params: unknown[] = [accountId];
  let where = "account_id = $1";
  if (opts.sourceType) {
    params.push(opts.sourceType);
    where += ` AND source_type = $${params.length}`;
  }
  if (opts.q && opts.q.trim()) {
    params.push(`%${opts.q.trim()}%`);
    where += ` AND text ILIKE $${params.length}`;
  }

  // Resolve effective entity filter: entityIds takes precedence over entityId.
  const effectiveEntityIds: number[] | undefined =
    opts.entityIds && opts.entityIds.length > 0
      ? opts.entityIds
      : opts.entityId !== undefined
        ? [opts.entityId]
        : undefined;

  if (effectiveEntityIds && effectiveEntityIds.length > 0) {
    const matchMode = opts.match ?? "all";
    params.push(effectiveEntityIds); // array param, e.g. $2
    const arrIdx = params.length;
    if (matchMode === "any") {
      // ANY: source must be mentioned by at least one of the selected entities.
      where += ` AND source_id IN (
        SELECT DISTINCT bc2.source_id
        FROM entity_mentions em2
        JOIN brain_chunks bc2 ON bc2.id = em2.chunk_id AND bc2.account_id = $1
        WHERE em2.entity_id = ANY($${arrIdx}::bigint[])
      )`;
    } else {
      // ALL: source must be mentioned by every selected entity.
      const n = effectiveEntityIds.length;
      params.push(n); // $n+1
      const countIdx = params.length;
      where += ` AND source_id IN (
        SELECT bc2.source_id
        FROM entity_mentions em2
        JOIN brain_chunks bc2 ON bc2.id = em2.chunk_id AND bc2.account_id = $1
        WHERE em2.entity_id = ANY($${arrIdx}::bigint[])
        GROUP BY bc2.source_id
        HAVING count(DISTINCT em2.entity_id) >= $${countIdx}
      )`;
    }
  }

  params.push(limit);
  const limIdx = params.length;
  params.push(offset);
  const offIdx = params.length;
  const { rows } = await p.query<{
    source_id: string;
    source_type: string;
    db_name: string | null;
    workspace: string | null;
    parent_url: string | null;
    first_line: string | null;
    doc_date: Date | null;
  }>(
    `SELECT source_id, source_type, db_name, workspace, parent_url, first_line, doc_date
       FROM (
         SELECT DISTINCT ON (source_id)
           source_id, source_type, db_name, workspace, parent_url,
           split_part(text, E'\n', 1) AS first_line,
           COALESCE((metadata->>'data')::date, source_updated::date) AS doc_date
         FROM brain_chunks
         WHERE ${where}
         ORDER BY source_id, chunk_index
       ) d
      ORDER BY doc_date DESC NULLS LAST, source_id
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params,
  );
  return rows.map((r) => ({
    source_id: r.source_id,
    source_type: r.source_type,
    db_name: r.db_name,
    workspace: r.workspace,
    parent_url: r.parent_url,
    title: titleFromHeaderLine(r.first_line),
    doc_date: r.doc_date ? new Date(r.doc_date).toISOString().slice(0, 10) : null,
  }));
}
