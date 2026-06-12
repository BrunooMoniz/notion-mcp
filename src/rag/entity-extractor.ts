// src/rag/entity-extractor.ts
// E4 Phase 1 — entity extraction entry-point, gated by ENTITIES_ENABLED.
// Dynamic imports keep this module off the hot path when the gate is off.
// Pattern mirrors facts-extractor.ts.
//
// SAFETY: try/catch in extractEntitiesForAccount ensures extraction errors
// NEVER propagate to the classifier and never break indexing.
//
// Frente D (#99) — multi-conta: runEntityExtraction() seleciona contas a partir
// de brain_chunks pendentes (chunks sem entity_mentions), cobrindo friend:* e
// qualquer account_id presente nos chunks, com orçamento por conta e global por
// run, priorizando contas com 0 entidades (backfill natural). Erros de LLM são
// agregados em 1 linha por conta (não por chunk) e os chunks pendentes ficam
// para o próximo cron.

/** Kill switch — off by default. */
export const ENTITIES_ENABLED = process.env.ENTITIES_ENABLED === "true";

/** Runtime gate: lido a cada run (não no import) para testes e crons. */
function entitiesEnabled(): boolean {
  return process.env.ENTITIES_ENABLED === "true";
}

/** Parse a positive integer env var, or undefined. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

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
// Account-level extraction (called from runEntityExtraction / backfill script)
// ---------------------------------------------------------------------------

export interface ExtractionStats {
  chunksProcessed: number;
  entitiesUpserted: number;
  errors: number;
  /** Última mensagem de erro do run (agregada — sem log por chunk). */
  lastError?: string;
}

export interface ExtractEntitiesOpts {
  /** Máximo de chunks neste run (LIMIT). Default: ENTITY_BUDGET_PER_ACCOUNT
   *  ou ENTITIES_BATCH_SIZE (legado) ou 200. */
  budget?: number;
  /** Circuit breaker: para a conta após N erros consecutivos (ex.: API sem
   *  créditos) em vez de queimar o orçamento inteiro em chamadas falhas. */
  maxConsecutiveErrors?: number;
  /** Test seam: substitui o pipeline LLM+upsert por chunk. */
  extractChunk?: (
    chunkId: string,
    text: string,
    metadata: Record<string, unknown>,
    accountId: string,
  ) => Promise<void>;
}

/**
 * Process NEW chunks for an account (chunks not yet having any entity_mention),
 * newest first, up to `budget`. Erros são contados e agregados em stats
 * (lastError), NUNCA logados por chunk — quem loga é o caller, 1 linha por
 * conta. Após `maxConsecutiveErrors` falhas seguidas a conta é abortada neste
 * run (os chunks continuam pendentes e o próximo cron tenta de novo).
 */
export async function extractEntitiesForAccount(
  accountId: string,
  opts: ExtractEntitiesOpts = {},
): Promise<ExtractionStats> {
  const stats: ExtractionStats = { chunksProcessed: 0, entitiesUpserted: 0, errors: 0 };
  if (!entitiesEnabled()) return stats;

  const { getPool } = await import("./storage.js");
  const budget = opts.budget ?? envInt("ENTITY_BUDGET_PER_ACCOUNT") ?? envInt("ENTITIES_BATCH_SIZE") ?? 200;
  const maxConsecutive = opts.maxConsecutiveErrors ?? 3;
  const extract = opts.extractChunk ?? extractFromChunk;
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
    [accountId, budget],
  );

  let consecutiveErrors = 0;
  for (const chunk of chunks) {
    try {
      await extract(chunk.id, chunk.text, chunk.metadata as Record<string, unknown>, accountId);
      stats.chunksProcessed++;
      consecutiveErrors = 0;
    } catch (err) {
      stats.errors++;
      consecutiveErrors++;
      stats.lastError = err instanceof Error ? err.message : String(err);
      if (consecutiveErrors >= maxConsecutive) break; // LLM fora do ar / sem créditos
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Multi-account run (called from the classifier cron) — Frente D (#99)
// ---------------------------------------------------------------------------

export interface AccountRunResult {
  accountId: string;
  /** Chunks da conta ainda sem entity_mentions no início do run. */
  pending: number;
  chunksProcessed: number;
  errors: number;
  lastError?: string;
}

export interface EntityRunStats {
  accounts: number;
  chunksProcessed: number;
  errors: number;
  perAccount: AccountRunResult[];
}

export interface RunEntityExtractionOpts {
  /** Orçamento de chunks por conta por run. Default: ENTITY_BUDGET_PER_ACCOUNT
   *  ou ENTITIES_BATCH_SIZE (legado) ou 200. */
  perAccountBudget?: number;
  /** Orçamento global de chunks por run. Default: ENTITY_BUDGET_GLOBAL ou 1000. */
  globalBudget?: number;
  /** Test seam: substitui extractEntitiesForAccount. */
  extractForAccount?: (accountId: string, budget: number) => Promise<ExtractionStats>;
  /** Sink das linhas agregadas de erro (1 por conta). Default: console.error. */
  log?: (line: string) => void;
}

/**
 * Um run de extração de entidades cobrindo TODAS as contas com chunks pendentes
 * (brain_chunks sem entity_mentions) — friend:*, operador, legadas — em vez da
 * tabela account. Contas com 0 entidades vêm primeiro (backfill natural).
 * Cada conta roda dentro do requestContext do próprio account (isolamento de
 * metering e de qualquer writer context-dependente). Erros viram 1 linha de
 * log por conta; os chunks pendentes ficam para o próximo cron.
 */
export async function runEntityExtraction(
  opts: RunEntityExtractionOpts = {},
): Promise<EntityRunStats> {
  const run: EntityRunStats = { accounts: 0, chunksProcessed: 0, errors: 0, perAccount: [] };
  if (!entitiesEnabled()) return run;

  const { getPool } = await import("./storage.js");
  const { requestContext } = await import("../context.js");

  const log = opts.log ?? ((line: string) => console.error(line));
  const perAccountBudget =
    opts.perAccountBudget ?? envInt("ENTITY_BUDGET_PER_ACCOUNT") ?? envInt("ENTITIES_BATCH_SIZE") ?? 200;
  const globalBudget = opts.globalBudget ?? envInt("ENTITY_BUDGET_GLOBAL") ?? 1000;
  const extractForAccount =
    opts.extractForAccount ??
    ((accountId: string, budget: number) => extractEntitiesForAccount(accountId, { budget }));

  const p = getPool();
  // Contas com trabalho pendente: chunks sem nenhuma entity_mention. Inclui
  // qualquer account_id presente em brain_chunks (friend:*, notion:*, etc.),
  // mesmo sem linha na tabela account. entity_count prioriza o backfill.
  const { rows } = await p.query<{ account_id: string; pending: number; entity_count: number }>(
    `SELECT bc.account_id,
            COUNT(*)::int AS pending,
            COALESCE((SELECT COUNT(*) FROM entities e WHERE e.account_id = bc.account_id), 0)::int AS entity_count
     FROM brain_chunks bc
     WHERE NOT EXISTS (
       SELECT 1 FROM entity_mentions em WHERE em.chunk_id = bc.id
     )
     GROUP BY bc.account_id
     ORDER BY entity_count ASC, bc.account_id ASC`,
  );

  // Reforço da ordem em JS (contas com 0 entidades primeiro, determinístico)
  // para não depender do ORDER BY quando o pool é injetado em teste.
  const accounts = [...rows].sort(
    (a, b) => a.entity_count - b.entity_count || a.account_id.localeCompare(b.account_id),
  );

  let remaining = globalBudget;
  for (const acct of accounts) {
    if (remaining <= 0) break;
    const budget = Math.min(perAccountBudget, remaining);

    let stats: ExtractionStats;
    try {
      stats = await requestContext.run(
        { authType: "bearer", scopes: [], accountId: acct.account_id },
        () => extractForAccount(acct.account_id, budget),
      );
    } catch (err) {
      // extractEntitiesForAccount não deveria lançar; se lançar (ex.: DB fora),
      // conta como 1 erro agregado e segue para a próxima conta.
      stats = {
        chunksProcessed: 0,
        entitiesUpserted: 0,
        errors: 1,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }

    run.accounts++;
    run.chunksProcessed += stats.chunksProcessed;
    run.errors += stats.errors;
    run.perAccount.push({
      accountId: acct.account_id,
      pending: acct.pending,
      chunksProcessed: stats.chunksProcessed,
      errors: stats.errors,
      lastError: stats.lastError,
    });
    remaining -= stats.chunksProcessed + stats.errors;

    if (stats.errors > 0) {
      // 1 linha agregada por conta — nunca por chunk. Próximo cron tenta de novo.
      log(
        `[entities] account=${acct.account_id} pending=${acct.pending} processed=${stats.chunksProcessed} ` +
          `errors=${stats.errors} lastError=${stats.lastError ?? "?"}`,
      );
    }
  }

  return run;
}
