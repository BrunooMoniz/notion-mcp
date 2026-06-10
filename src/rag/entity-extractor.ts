// src/rag/entity-extractor.ts
// E4 Phase 1 — entity extraction entry-point, gated by ENTITIES_ENABLED.
// Dynamic imports keep this module off the hot path when the gate is off.
// Pattern mirrors facts-extractor.ts.
//
// SAFETY: try/catch in extractEntitiesForAccount ensures extraction errors
// NEVER propagate to the classifier and never break indexing.

/** Kill switch — off by default. */
export const ENTITIES_ENABLED = process.env.ENTITIES_ENABLED === "true";

const ENTITY_TYPES = new Set(["pessoa", "empresa", "projeto"]);

const EXTRACTION_SYSTEM =
  'Você é um extrator de entidades para o segundo cérebro. ' +
  'Extraia pessoas, empresas e projetos mencionados no texto abaixo. ' +
  'Responda APENAS com um array JSON. Cada item: { "name": string, "type": "pessoa"|"empresa"|"projeto" }. ' +
  'Regras: apenas entidades CONCRETAS com nome próprio identificável. ' +
  'Ignore termos genéricos ("equipe", "mercado"). Se não houver entidade, retorne [].';

// ---------------------------------------------------------------------------
// Metadata fast-path: extract pessoas/attendees without calling the LLM
// ---------------------------------------------------------------------------

export interface RawEntity {
  name: string;
  type: "pessoa" | "empresa" | "projeto";
  confidence: number;
}

/**
 * Extract entities from structured metadata fields (pessoas, attendees).
 * Returns confidence=1.0 entries — no LLM call needed.
 */
export function extractEntitiesFromMetadata(metadata: Record<string, unknown>): RawEntity[] {
  const seen = new Set<string>();
  const out: RawEntity[] = [];

  function addFromArray(field: unknown, type: "pessoa"): void {
    if (!Array.isArray(field)) return;
    for (const item of field) {
      if (typeof item !== "string" || !item.trim()) continue;
      const name = item.trim();
      const key = `${type}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, type, confidence: 1.0 });
    }
  }

  addFromArray(metadata["pessoas"], "pessoa");
  addFromArray(metadata["attendees"], "pessoa");
  return out;
}

// ---------------------------------------------------------------------------
// LLM response parser
// ---------------------------------------------------------------------------

/**
 * Parse the raw LLM response (possibly with markdown fences) into RawEntity[].
 * Returns [] on any parse error — never throws.
 */
export function parseEntityResponse(raw: string): RawEntity[] {
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();
    // Find the array
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const result: RawEntity[] = [];
    for (const item of parsed) {
      if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
      if (!ENTITY_TYPES.has(item.type)) continue;
      result.push({ name: item.name.trim(), type: item.type as RawEntity["type"], confidence: 0.8 });
    }
    return result;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-chunk extraction (called from extractEntitiesForAccount)
// ---------------------------------------------------------------------------

async function extractFromChunk(
  chunkId: string,
  chunkText: string,
  metadata: Record<string, unknown>,
  accountId: string,
): Promise<void> {
  const { normalizeEntityName, findSimilarEntity, upsertEntity, upsertEntityMention } =
    await import("./entity-storage.js");

  // 1. High-confidence entities from metadata (no LLM)
  const metaEntities = extractEntitiesFromMetadata(metadata);

  // 2. LLM extraction from chunk text for non-pessoa types
  let llmEntities: RawEntity[] = [];
  const trimmed = (chunkText ?? "").trim();
  if (trimmed) {
    const { callHaiku } = await import("../classifier/anthropic.js");
    // Pass accountId so callHaiku meters the LLM usage against the account
    // that owns the chunk being processed.
    const result = await callHaiku(EXTRACTION_SYSTEM, trimmed.slice(0, 4000), accountId, "entity-extractor");
    llmEntities = parseEntityResponse(result.text);
  }

  // Merge: metadata entities take precedence (confidence 1.0)
  const metaKeys = new Set(metaEntities.map((e) => `${e.type}:${e.name.toLowerCase()}`));
  const allEntities = [
    ...metaEntities,
    ...llmEntities.filter((e) => !metaKeys.has(`${e.type}:${e.name.toLowerCase()}`)),
  ];

  for (const rawEnt of allEntities) {
    const canonical = normalizeEntityName(rawEnt.name);
    if (!canonical) continue;

    // Fuzzy dedup: check if a similar entity exists
    const existing = await findSimilarEntity(accountId, rawEnt.type, canonical);
    let entityId: number;
    if (existing) {
      // Add as alias and update
      entityId = await upsertEntity(accountId, rawEnt.type, existing.name, [canonical]);
    } else {
      entityId = await upsertEntity(accountId, rawEnt.type, canonical, []);
    }

    await upsertEntityMention(entityId, chunkId, rawEnt.confidence);
  }
}

// ---------------------------------------------------------------------------
// Account-level extraction (called from the classifier cron)
// ---------------------------------------------------------------------------

export interface ExtractionStats {
  chunksProcessed: number;
  entitiesUpserted: number;
  errors: number;
}

/**
 * Process NEW chunks for an account (chunks not yet having any entity_mention).
 * Respects ENTITIES_BATCH_SIZE env var (default 200). Called from the classifier
 * cron — errors are caught and never propagate.
 */
export async function extractEntitiesForAccount(accountId: string): Promise<ExtractionStats> {
  const stats: ExtractionStats = { chunksProcessed: 0, entitiesUpserted: 0, errors: 0 };
  if (!ENTITIES_ENABLED) return stats;

  const { getPool } = await import("./storage.js");
  const batchSize = parseInt(process.env.ENTITIES_BATCH_SIZE ?? "200", 10);
  const p = getPool();

  // Get chunks not yet processed (no entity_mention at all)
  const { rows: chunks } = await p.query<{
    id: string;
    text: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT bc.id, bc.text, bc.metadata
     FROM brain_chunks bc
     WHERE bc.account_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM entity_mentions em WHERE em.chunk_id = bc.id
       )
     ORDER BY bc.indexed_at DESC
     LIMIT $2`,
    [accountId, batchSize],
  );

  for (const chunk of chunks) {
    try {
      await extractFromChunk(chunk.id, chunk.text, chunk.metadata as Record<string, unknown>, accountId);
      stats.chunksProcessed++;
    } catch (err) {
      stats.errors++;
      console.error(`[entities] chunk ${chunk.id} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return stats;
}
