// src/rag/search.ts
import {
  searchSemantic as searchSemanticImpl,
  searchKeyword as searchKeywordImpl,
  getNeighbors,
} from "./storage.js";
import { embedQuery as embedQueryImpl } from "./embeddings.js";
import {
  rerankDocuments as rerankDocumentsImpl,
  rerankEnabled,
  type RerankResult,
} from "./rerank.js";
import type { Chunk, SearchFilters, SearchHit, SearchMode, Workspace } from "./types.js";
import { getAllowedWorkspaces as getAllowedWorkspacesImpl } from "../getAllowedWorkspaces.js";
import { getAccountId } from "../context.js";
import { recordUsage } from "./usage.js";
import { assertSearchWithinLimit, assertCreditsWithinLimit } from "../billing/usage.js";
import { applyFinalScore, getUtilityAlpha, computeEffectiveUtility } from "./utility.js";

export interface RankedChunk {
  chunk: Chunk;
  rank: number;
  score?: number;
}

export function reciprocalRankFusion(
  lists: RankedChunk[][],
  poolSize: number,
  k = 60,
): SearchHit[] {
  const scores = new Map<string, { chunk: Chunk; score: number }>();
  for (const list of lists) {
    for (const { chunk, rank } of list) {
      const prev = scores.get(chunk.id);
      const incr = 1 / (k + rank);
      if (prev) prev.score += incr;
      else scores.set(chunk.id, { chunk, score: incr });
    }
  }
  // Return up to poolSize fused candidates. Callers that want a reranker pool
  // pass the full pool size (e.g. max(30, topK*4)) so RRF does not pre-slice
  // the candidate set down to a small topK before reranking.
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, poolSize)
    .map((s) => ({ chunk: s.chunk, score: s.score }));
}

// --- F.4.2: workspace-scope enforcement ------------------------------------

/**
 * Build the workspace-scope WHERE fragment + params for a request.
 *
 * `allowed` is the caller's allowed workspaces (from getAllowedWorkspaces):
 *   - `null`  -> bearer "all" / cron / eval / tests: NO scope clause (unfiltered).
 *   - array   -> a scoped OAuth token: hard-restrict to these workspaces.
 *
 * The result is intersected with the caller's requested `workspace` filter (if
 * any): asking for a workspace outside the token's scope yields an EMPTY array,
 * which compiles to `workspace = ANY('{}')` -> zero rows. This is the security
 * default: a scoped token can never read another workspace's chunks, and a
 * malicious/buggy caller filter cannot widen the scope.
 *
 * `startIdx` is the 1-based placeholder index for the emitted `$N`.
 * Exported pure so unit tests can assert the SQL/params without a live DB.
 */
export function buildWorkspaceScopeClause(
  allowed: Workspace[] | null,
  callerFilter: { workspace?: Workspace } | undefined,
  startIdx = 1,
): { sql: string; params: unknown[] } {
  if (allowed === null) return { sql: "", params: [] };
  const requested = callerFilter?.workspace;
  // Intersect the token's allowed set with the caller's requested workspace.
  const effective = requested
    ? allowed.filter((w) => w === requested)
    : allowed;
  return {
    sql: `workspace = ANY($${startIdx})`,
    params: [effective],
  };
}

/**
 * Compute the effective allowed-workspace list to thread into SearchFilters as
 * `_allowedWorkspaces`. Returns `undefined` (no restriction) for null/all,
 * otherwise the intersection of the token scope and the caller's requested
 * workspace (possibly empty = zero rows).
 */
function effectiveAllowedWorkspaces(
  allowed: Workspace[] | null,
  callerFilter: SearchFilters | undefined,
): Workspace[] | undefined {
  if (allowed === null) return undefined;
  const requested = callerFilter?.workspace;
  return requested ? allowed.filter((w) => w === requested) : allowed;
}

// --- dependency-injection seam (test-only) ---------------------------------
// brainSearch reaches storage/embeddings/rerank through these references so a
// unit test can replace them with fakes (no DB, no Voyage, no creds). In
// production they point at the real implementations.

type SearchSemanticFn = (
  queryEmbedding: number[],
  filters: SearchFilters | undefined,
  topK: number,
) => Promise<{ chunk: Chunk; rank: number; score: number }[]>;
type SearchKeywordFn = (
  queryText: string,
  filters: SearchFilters | undefined,
  topK: number,
) => Promise<{ chunk: Chunk; rank: number; score: number }[]>;
type EmbedQueryFn = (text: string) => Promise<number[]>;
type RerankFn = (
  query: string,
  docs: { id: string; text: string }[],
  topN: number,
  instructionPtBr?: string,
  opts?: { retries?: number },
) => Promise<RerankResult[]>;

interface SearchDeps {
  searchSemantic: SearchSemanticFn;
  searchKeyword: SearchKeywordFn;
  embedQuery: EmbedQueryFn;
  rerankDocuments: RerankFn;
  getAllowedWorkspaces: () => Workspace[] | null;
}

const defaultDeps: SearchDeps = {
  searchSemantic: searchSemanticImpl,
  searchKeyword: searchKeywordImpl,
  embedQuery: embedQueryImpl,
  rerankDocuments: rerankDocumentsImpl,
  getAllowedWorkspaces: getAllowedWorkspacesImpl,
};

let deps: SearchDeps = defaultDeps;

/** Test-only seam: inject fake deps (or pass null to restore real ones). */
export function __setSearchDepsForTest(d: Partial<SearchDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

export interface SearchOptions {
  topK?: number;
  mode?: SearchMode;
  filters?: SearchFilters;
  includeNeighbors?: boolean;
  /**
   * Cross-encoder rerank toggle. Default true. The env kill-switch
   * RERANK_ENABLED=false overrides this to off (see rerankEnabled()).
   */
  rerank?: boolean;
}

// Minimum cosine-similarity cutoff for the RRF-fallback path (rerank disabled
// or Voyage returned all-null). 0.0 = keep everything; override with MIN_SIM.
function minSimCutoff(): number {
  const v = Number(process.env.MIN_SIM);
  return Number.isFinite(v) ? v : 0.0;
}

// Max kept hits per real parent_url before later hits from the same page are
// dropped (result diversity). Override with BRAIN_MAX_PER_URL (default 3).
function maxPerUrlConfig(): number {
  const v = Number(process.env.BRAIN_MAX_PER_URL ?? 3);
  return Number.isFinite(v) ? v : 3;
}

/**
 * Optional recency boost applied AFTER reranking (or after RRF fallback).
 * Controlled by RECENCY_BOOST env var (default "off" / 0).
 *
 * Formula: final_score = score * (1 + beta * exp(-age_days / halflife))
 *   beta     = RECENCY_BOOST  (e.g. 0.15 → max +15% for today's docs)
 *   halflife = RECENCY_HALFLIFE_DAYS (default 30)
 *   age_days derived from chunk.metadata.data (ISO date string) or source_updated.
 *
 * With RECENCY_BOOST=0 (or unset) returns hits unchanged — zero cost.
 * Positive beta boosts recent content; negative beta penalizes it (unusual).
 */
export function recencyBoostEnabled(): boolean {
  const v = Number(process.env.RECENCY_BOOST);
  return Number.isFinite(v) && v !== 0;
}

export function applyRecencyBoost(hits: SearchHit[], now: Date = new Date()): SearchHit[] {
  const beta = Number(process.env.RECENCY_BOOST);
  if (!Number.isFinite(beta) || beta === 0) return hits;
  const halflife = Number(process.env.RECENCY_HALFLIFE_DAYS ?? 30);
  const hl = Number.isFinite(halflife) && halflife > 0 ? halflife : 30;
  // ln(2)/halflife is the decay constant for exp(-age * lambda)
  const lambda = Math.LN2 / hl;

  const boosted = hits.map((h) => {
    const dateStr =
      (typeof h.chunk.metadata?.data === "string" ? h.chunk.metadata.data : undefined) ??
      (h.chunk.source_updated instanceof Date ? h.chunk.source_updated.toISOString() : undefined);
    if (!dateStr) return h;
    const docDate = new Date(dateStr);
    if (isNaN(docDate.getTime())) return h;
    const ageDays = Math.max(0, (now.getTime() - docDate.getTime()) / 86_400_000);
    const boost = 1 + beta * Math.exp(-ageDays * lambda);
    return { ...h, score: h.score * boost };
  });

  // Re-sort by boosted score (recency may reorder).
  return boosted.sort((a, b) => b.score - a.score);
}

/**
 * Query-time result diversification. Iterates `hits` in their given (already
 * ranked) order and KEEPS a hit unless:
 *   - its trimmed `chunk.text` is identical to one already kept (exact-duplicate
 *     text indexed under multiple URLs — keep the first/highest-ranked), or
 *   - its `chunk.parent_url` already has `maxPerUrl` hits kept.
 * Stops once `topK` are kept. Order is preserved. A null/empty parent_url is
 * treated as un-capped (we don't collapse unknown-origin chunks together).
 * Recall is preserved: the first occurrence of each url always survives.
 */
export function diversifyHits(
  hits: SearchHit[],
  opts: { topK: number; maxPerUrl?: number },
): SearchHit[] {
  const maxPerUrl = opts.maxPerUrl ?? 3;
  const kept: SearchHit[] = [];
  const seenText = new Set<string>();
  const urlCounts = new Map<string, number>();

  for (const hit of hits) {
    if (kept.length >= opts.topK) break;

    const text = (hit.chunk.text ?? "").trim();
    if (text.length > 0 && seenText.has(text)) continue; // exact-duplicate text

    const url = hit.chunk.parent_url?.trim();
    if (url) {
      const count = urlCounts.get(url) ?? 0;
      if (count >= maxPerUrl) continue; // url already at its cap
      urlCounts.set(url, count + 1);
    }

    if (text.length > 0) seenText.add(text);
    kept.push(hit);
  }

  return kept;
}

/**
 * Dedup RRF pool by source_id, keeping the highest-scored chunk per document.
 * Preserves the original score order so the top-ranked chunk of each document
 * surfaces first. This gives the reranker a more diverse candidate set (one
 * representative chunk per document instead of several chunks from the same
 * source competing for top-N slots).
 *
 * Exported pure for unit testing.
 */
export function dedupBySourceId(pool: SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const hit of pool) {
    const sid = hit.chunk.source_id;
    if (!sid) continue;
    const prev = seen.get(sid);
    if (!prev || hit.score > prev.score) seen.set(sid, hit);
  }
  // Preserve descending-score order.
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/** Min-max normalize RRF scores into [0,1], cosine as the tie-break. */
function normalizeFallback(
  pool: SearchHit[],
  cosineById: Map<string, number>,
): SearchHit[] {
  if (pool.length === 0) return [];
  const scores = pool.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;
  return pool
    .map((h) => ({
      ...h,
      score: span > 0 ? (h.score - min) / span : 1,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // tie-break by cosine similarity from the semantic pass
      return (cosineById.get(b.chunk.id) ?? 0) - (cosineById.get(a.chunk.id) ?? 0);
    });
}

export async function brainSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 12;
  const mode = opts.mode ?? "hybrid";
  // Over-fetch a candidate pool so the reranker has enough to work with.
  const poolSize = Math.max(30, topK * 4);
  const maxPerUrl = maxPerUrlConfig();

  // F.4.2 — enforce the caller's workspace scope at the SQL layer. We compute the
  // effective allowed-workspace list (token scope intersected with the caller's
  // requested workspace) and thread it into the filters as _allowedWorkspaces so
  // EVERY query (semantic + keyword) is hard-restricted. A scoped token asking
  // for a workspace outside its scope gets an empty list -> zero rows (no leak).
  // null (bearer/cron/eval/tests) -> undefined -> no restriction.
  const allowedWorkspaces = effectiveAllowedWorkspaces(
    deps.getAllowedWorkspaces(),
    opts.filters,
  );
  // F3.0 — tenant guard. account_id comes from the trusted request context
  // (getAccountId → default account for cron/eval/tests), NEVER from input; strip
  // any caller-supplied internal guards before threading the server-side ones.
  const accountId = getAccountId();
  const callerFilters = { ...(opts.filters ?? {}) } as SearchFilters;
  delete callerFilters._accountId;
  delete callerFilters._allowedWorkspaces;
  const filters: SearchFilters = {
    ...callerFilters,
    _accountId: accountId,
    ...(allowedWorkspaces !== undefined ? { _allowedWorkspaces: allowedWorkspaces } : {}),
  };

  // Fase 3 billing — hard-cap searches/month for non-owner accounts. Throws
  // QuotaExceededError (surfaced by the brain_search tool as a friendly message).
  // Owner/default account is exempt (no DB hit) so cron/eval/tests are unchanged.
  await assertSearchWithinLimit(accountId);

  // F7 — credit gate. Respects PLAN_ENFORCEMENT mode (off/soft/hard). In soft
  // (default), never blocks; in hard, throws QuotaExceededError when credits
  // exhausted. ilimitado and owner are never hard-blocked.
  await assertCreditsWithinLimit(accountId, "search", 1);

  // F3.0 — passive metering (best-effort, never blocks the search).
  await recordUsage(accountId, "search", 1);

  let hits: SearchHit[] = [];

  if (mode === "keyword") {
    // Keyword-only: expose the real ts_rank score, trim to topK.
    const kwHits = await deps.searchKeyword(query, filters, poolSize);
    hits = kwHits
      .slice(0, topK)
      .map((h) => ({ chunk: h.chunk, score: h.score }));
  } else if (mode === "semantic") {
    // Semantic-only: expose the real cosine similarity (not 1/rank).
    const qEmbed = await deps.embedQuery(query);
    const semHits = await deps.searchSemantic(qEmbed, filters, poolSize);
    hits = semHits
      .slice(0, topK)
      .map((h) => ({ chunk: h.chunk, score: h.score }));
  } else {
    // Hybrid: over-fetch both, fuse to the full pool, then rerank -> topK.
    const qEmbed = await deps.embedQuery(query);
    const semHits = await deps.searchSemantic(qEmbed, filters, poolSize);
    const kwHits = await deps.searchKeyword(query, filters, poolSize);

    // Keep cosine per chunk for the fallback tie-break.
    const cosineById = new Map<string, number>();
    for (const h of semHits) cosineById.set(h.chunk.id, h.score);

    const pool = reciprocalRankFusion([semHits, kwHits], poolSize);
    // Dedup by source_id before reranking: keep only the best-scored chunk per
    // document. This gives the cross-encoder a more diverse candidate set so a
    // single long document cannot crowd out other relevant documents in the pool.
    const dedupedPool = dedupBySourceId(pool);
    const poolByChunkId = new Map(pool.map((h) => [h.chunk.id, h]));

    let reranked = false;
    if (rerankEnabled(opts.rerank)) {
      // Rank MORE than topK (topK*3, capped to the deduped pool) so diversifyHits
      // has material to swap in once duplicates/over-represented urls are dropped.
      const rerankN = Math.min(dedupedPool.length, topK * 3);
      const results = await deps.rerankDocuments(
        query,
        dedupedPool.map((p) => ({ id: p.chunk.id, text: p.chunk.text })),
        rerankN,
      );
      const anyScored = results.some((r) => r.relevance_score !== null);
      if (anyScored) {
        // Use the reranker's relevance_score, apply utility boost, then diversify.
        // Spec 004 §3: final = rerank_score * (1 + UTILITY_ALPHA * tanh(eff_utility/10))
        // alpha=0 reproduces pre-spec ranking byte-for-byte (kill switch).
        const alpha = getUtilityAlpha();
        const ranked = results
          .map((r) => {
            const ph = poolByChunkId.get(r.id);
            if (!ph) return null;
            const rerankScore = r.relevance_score as number;
            const effUtility = computeEffectiveUtility(
              ph.chunk.utility_score ?? 0,
              ph.chunk.last_useful_at ?? null,
            );
            const finalScore = applyFinalScore(rerankScore, effUtility, alpha);
            return { chunk: ph.chunk, score: finalScore };
          })
          .filter((h): h is SearchHit => h !== null)
          // Re-sort by final score (utility may reorder equal-score neighbors).
          .sort((a, b) => b.score - a.score);
        hits = diversifyHits(ranked, { topK, maxPerUrl });
        reranked = true;
      }
    }

    if (!reranked) {
      // Rerank disabled or Voyage returned all-null: min-max normalize the RRF
      // scores, cosine tie-break, apply the minimum-similarity cutoff, then
      // diversify (dedup text + cap per url) down to topK.
      const cutoff = minSimCutoff();
      const normalized = normalizeFallback(pool, cosineById).filter(
        (h) => (cosineById.get(h.chunk.id) ?? 1) >= cutoff,
      );
      hits = diversifyHits(normalized, { topK, maxPerUrl });
    }
  }

  // Optional recency boost (RECENCY_BOOST env, default off). Applied after all
  // ranking/diversification so it can only reorder within the already-diversified
  // topK set, not expand it. Zero cost when RECENCY_BOOST=0 or unset.
  hits = applyRecencyBoost(hits);

  if (opts.includeNeighbors) {
    for (const hit of hits) {
      hit.neighbors = await getNeighbors(
        hit.chunk.source_id,
        hit.chunk.chunk_index,
        accountId,
        hit.chunk.workspace,
      );
    }
  }

  return hits;
}
