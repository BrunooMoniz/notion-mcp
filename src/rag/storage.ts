// src/rag/storage.ts
import pg from "pg";
import type { ChunkWithEmbedding, Chunk, SearchFilters } from "./types.js";
import { formatVector } from "./embeddings.js";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
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
       text, embedding, metadata, source_updated, indexed_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb, $11, now())
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
    ]);
  }
}

export async function deleteBySource(sourceType: string, sourceId: string): Promise<void> {
  const p = getPool();
  await p.query(`DELETE FROM brain_chunks WHERE source_type=$1 AND source_id=$2`, [
    sourceType,
    sourceId,
  ]);
}

export async function getSyncState(sourceType: string): Promise<Date> {
  const p = getPool();
  const { rows } = await p.query<{ last_sync_at: Date }>(
    `SELECT last_sync_at FROM sync_state WHERE source_type=$1`,
    [sourceType],
  );
  return rows[0]?.last_sync_at ?? new Date(0);
}

export async function setSyncState(sourceType: string, ts: Date): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO sync_state (source_type, last_sync_at)
     VALUES ($1, $2)
     ON CONFLICT (source_type) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at`,
    [sourceType, ts],
  );
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

function buildFilterClauses(
  filters: SearchFilters | undefined,
  startIdx: number,
): { sql: string; params: unknown[] } {
  if (!filters) return { sql: "", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
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
  if (filters.date_from) {
    clauses.push(`(metadata->>'data')::date >= $${i++}::date`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    clauses.push(`(metadata->>'data')::date <= $${i++}::date`);
    params.push(filters.date_to);
  }
  if (filters.pessoa) {
    clauses.push(`metadata->'pessoas' @> $${i++}::jsonb`);
    params.push(JSON.stringify([filters.pessoa]));
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
): Promise<{ chunk: Chunk; rank: number }[]> {
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
  return rows.map((r, idx) => ({ chunk: rowToChunk(r), rank: idx + 1 }));
}

export async function searchKeyword(
  queryText: string,
  filters: SearchFilters | undefined,
  topK: number,
): Promise<{ chunk: Chunk; rank: number }[]> {
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
  return rows.map((r, idx) => ({ chunk: rowToChunk(r), rank: idx + 1 }));
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
