// src/rag/entity-storage.ts
// E4 Phase 1 — thin DB layer for entities + entity_mentions tables.
// Mirrors patterns in facts-storage.ts: reuses getPool() from storage.ts so
// __setPoolForTest works for both. All values parameterized.
import { getPool, titleFromHeaderLine } from "./storage.js";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Canonical form: lowercase, NFD-decomposed, combining diacritics stripped,
 * non-alphanumeric collapsed to single space, trimmed. Same algorithm the
 * classifier uses for names.
 */
export function normalizeEntityName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

/**
 * INSERT entity (canonical name) ON CONFLICT DO UPDATE aliases.
 * Returns the entity id (existing or newly inserted).
 */
export async function upsertEntity(
  accountId: string,
  type: string,
  canonicalName: string,
  newAliases: string[],
): Promise<number> {
  const p = getPool();
  const { rows } = await p.query<{ id: number }>(
    `INSERT INTO entities (account_id, type, name, aliases, updated_at)
     VALUES ($1, $2, $3, $4::text[], now())
     ON CONFLICT (account_id, type, name) DO UPDATE
       SET aliases = array_distinct(entities.aliases || EXCLUDED.aliases),
           updated_at = now()
     RETURNING id`,
    [accountId, type, canonicalName, newAliases],
  );
  return rows[0].id;
}

/**
 * INSERT entity_mention ON CONFLICT DO UPDATE confidence (take max).
 */
export async function upsertEntityMention(
  entityId: number,
  chunkId: string,
  confidence: number,
): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO entity_mentions (entity_id, chunk_id, confidence)
     VALUES ($1, $2, $3)
     ON CONFLICT (entity_id, chunk_id) DO UPDATE
       SET confidence = GREATEST(entity_mentions.confidence, EXCLUDED.confidence),
           extracted_at = now()`,
    [entityId, chunkId, confidence],
  );
}

// ---------------------------------------------------------------------------
// Fuzzy dedup
// ---------------------------------------------------------------------------

export interface EntityRow {
  id: number;
  name: string;
  aliases: string[];
}

/**
 * Find an existing entity for the same account+type whose name is similar to
 * `input` (pg_trgm similarity >= 0.7 OR input is a substring of name or vice
 * versa). Returns the first match or null. NEVER crosses accounts.
 */
export async function findSimilarEntity(
  accountId: string,
  type: string,
  input: string,
): Promise<EntityRow | null> {
  const p = getPool();
  const { rows } = await p.query<{ id: number; name: string; aliases: string[]; similarity: number }>(
    `SELECT id, name, aliases, similarity(name, $3) AS similarity
     FROM entities
     WHERE account_id = $1
       AND type = $2
       AND (
         similarity(name, $3) >= 0.7
         OR lower(name) LIKE '%' || lower($3) || '%'
         OR lower($3) LIKE '%' || lower(name) || '%'
       )
     ORDER BY similarity DESC
     LIMIT 1`,
    [accountId, type, input],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name, aliases: rows[0].aliases };
}

// ---------------------------------------------------------------------------
// List entities (portal API)
// ---------------------------------------------------------------------------

export interface EntityListItem {
  id: number;
  type: string;
  name: string;
  aliases: string[];
  mention_count: number;
  doc_count: number;
}

export interface ListEntitiesOpts {
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListEntitiesResult {
  entities: EntityListItem[];
  total: number;
}

export async function listEntities(
  accountId: string,
  opts: ListEntitiesOpts,
): Promise<ListEntitiesResult> {
  const p = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const params: unknown[] = [accountId];
  const clauses: string[] = ["e.account_id = $1"];
  let i = 2;

  if (opts.type) {
    clauses.push(`e.type = $${i++}`);
    params.push(opts.type);
  }
  if (opts.q && opts.q.trim()) {
    clauses.push(`unaccent(e.name) ILIKE unaccent($${i++})`);
    params.push(`%${opts.q.trim()}%`);
  }

  const where = clauses.join(" AND ");

  // Count total (no pagination)
  const countParams = [...params];
  const { rows: countRows } = await p.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM entities e WHERE ${where}`,
    countParams,
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  // Main query with mention_count + doc_count
  params.push(limit);
  const limIdx = params.length;
  params.push(offset);
  const offIdx = params.length;

  const { rows } = await p.query<{
    id: number;
    type: string;
    name: string;
    aliases: string[];
    mention_count: string;
    doc_count: string;
  }>(
    `SELECT e.id, e.type, e.name, e.aliases,
            COUNT(em.id)::text AS mention_count,
            COUNT(DISTINCT bc.source_id)::text AS doc_count
     FROM entities e
     LEFT JOIN entity_mentions em ON em.entity_id = e.id
     LEFT JOIN brain_chunks bc ON bc.id = em.chunk_id AND bc.account_id = $1
     WHERE ${where}
     GROUP BY e.id, e.type, e.name, e.aliases
     ORDER BY COUNT(em.id) DESC, e.name
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    params,
  );

  return {
    entities: rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      aliases: r.aliases,
      mention_count: parseInt(r.mention_count, 10),
      doc_count: parseInt(r.doc_count, 10),
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// List documents for an entity (portal API)
// ---------------------------------------------------------------------------

export interface EntityDocumentRow {
  source_id: string;
  source_type: string;
  parent_url: string | null;
  title: string;
  doc_date: string | null;
  confidence: number;
}

export interface EntityDocumentsResult {
  entity: { id: number; type: string; name: string };
  documents: EntityDocumentRow[];
  total: number;
}

/**
 * Returns null if entity does not belong to accountId (→ caller returns 404).
 */
export async function listEntityDocuments(
  accountId: string,
  entityId: number,
  opts: { limit?: number; offset?: number },
): Promise<EntityDocumentsResult | null> {
  const p = getPool();

  // Ownership check: entity must belong to this account
  const { rows: eRows } = await p.query<{ id: number; type: string; name: string }>(
    `SELECT id, type, name FROM entities WHERE id = $1 AND account_id = $2`,
    [entityId, accountId],
  );
  if (eRows.length === 0) return null;
  const entity = eRows[0];

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const { rows } = await p.query<{
    source_id: string;
    source_type: string;
    parent_url: string | null;
    metadata: Record<string, unknown>;
    source_updated: Date | null;
    confidence: number;
    first_line: string | null;
  }>(
    `SELECT bc.source_id, bc.source_type, bc.parent_url,
            bc.metadata, bc.source_updated,
            MAX(em.confidence) AS confidence,
            MIN(bc.text) AS first_line
     FROM entity_mentions em
     JOIN brain_chunks bc ON bc.id = em.chunk_id AND bc.account_id = $2
     WHERE em.entity_id = $1
     GROUP BY bc.source_id, bc.source_type, bc.parent_url, bc.metadata, bc.source_updated
     ORDER BY MAX(em.confidence) DESC, bc.source_updated DESC NULLS LAST
     LIMIT $3 OFFSET $4`,
    [entityId, accountId, limit, offset],
  );

  // Count total docs
  const { rows: cRows } = await p.query<{ count: string }>(
    `SELECT COUNT(DISTINCT bc.source_id)::text AS count
     FROM entity_mentions em
     JOIN brain_chunks bc ON bc.id = em.chunk_id AND bc.account_id = $2
     WHERE em.entity_id = $1`,
    [entityId, accountId],
  );
  const total = parseInt(cRows[0]?.count ?? "0", 10);

  return {
    entity: { id: entity.id, type: entity.type, name: entity.name },
    documents: rows.map((r) => ({
      source_id: r.source_id,
      source_type: r.source_type,
      parent_url: r.parent_url,
      title: titleFromHeaderLine(r.first_line),
      doc_date: r.source_updated ? new Date(r.source_updated).toISOString().slice(0, 10) : null,
      confidence: r.confidence,
    })),
    total,
  };
}
