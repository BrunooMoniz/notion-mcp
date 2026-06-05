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
    const poolByChunkId = new Map(pool.map((h) => [h.chunk.id, h]));

    let reranked = false;
    if (rerankEnabled(opts.rerank)) {
      // Rank MORE than topK (topK*3, capped to the pool) so diversifyHits has
      // material to swap in once duplicates/over-represented urls are dropped.
      const rerankN = Math.min(pool.length, topK * 3);
      const results = await deps.rerankDocuments(
        query,
        pool.map((p) => ({ id: p.chunk.id, text: p.chunk.text })),
        rerankN,
      );
      const anyScored = results.some((r) => r.relevance_score !== null);
      if (anyScored) {
        // Use the reranker's relevance_score, in its returned (desc) order,
        // then diversify (dedup text + cap per url) down to topK.
        const ranked = results
          .map((r) => {
            const ph = poolByChunkId.get(r.id);
            if (!ph) return null;
            return { chunk: ph.chunk, score: r.relevance_score as number };
          })
          .filter((h): h is SearchHit => h !== null);
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

  if (opts.includeNeighbors) {
    for (const hit of hits) {
      hit.neighbors = await getNeighbors(hit.chunk.source_id, hit.chunk.chunk_index);
    }
  }

  return hits;
}
