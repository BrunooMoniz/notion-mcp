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
import type { Chunk, SearchFilters, SearchHit, SearchMode } from "./types.js";

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
}

const defaultDeps: SearchDeps = {
  searchSemantic: searchSemanticImpl,
  searchKeyword: searchKeywordImpl,
  embedQuery: embedQueryImpl,
  rerankDocuments: rerankDocumentsImpl,
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

  let hits: SearchHit[] = [];

  if (mode === "keyword") {
    // Keyword-only: expose the real ts_rank score, trim to topK.
    const kwHits = await deps.searchKeyword(query, opts.filters, poolSize);
    hits = kwHits
      .slice(0, topK)
      .map((h) => ({ chunk: h.chunk, score: h.score }));
  } else if (mode === "semantic") {
    // Semantic-only: expose the real cosine similarity (not 1/rank).
    const qEmbed = await deps.embedQuery(query);
    const semHits = await deps.searchSemantic(qEmbed, opts.filters, poolSize);
    hits = semHits
      .slice(0, topK)
      .map((h) => ({ chunk: h.chunk, score: h.score }));
  } else {
    // Hybrid: over-fetch both, fuse to the full pool, then rerank -> topK.
    const qEmbed = await deps.embedQuery(query);
    const semHits = await deps.searchSemantic(qEmbed, opts.filters, poolSize);
    const kwHits = await deps.searchKeyword(query, opts.filters, poolSize);

    // Keep cosine per chunk for the fallback tie-break.
    const cosineById = new Map<string, number>();
    for (const h of semHits) cosineById.set(h.chunk.id, h.score);

    const pool = reciprocalRankFusion([semHits, kwHits], poolSize);
    const poolByChunkId = new Map(pool.map((h) => [h.chunk.id, h]));

    let reranked = false;
    if (rerankEnabled(opts.rerank)) {
      const results = await deps.rerankDocuments(
        query,
        pool.map((p) => ({ id: p.chunk.id, text: p.chunk.text })),
        topK,
      );
      const anyScored = results.some((r) => r.relevance_score !== null);
      if (anyScored) {
        // Use the reranker's relevance_score, in its returned (desc) order.
        hits = results
          .map((r) => {
            const ph = poolByChunkId.get(r.id);
            if (!ph) return null;
            return { chunk: ph.chunk, score: r.relevance_score as number };
          })
          .filter((h): h is SearchHit => h !== null)
          .slice(0, topK);
        reranked = true;
      }
    }

    if (!reranked) {
      // Rerank disabled or Voyage returned all-null: min-max normalize the RRF
      // scores, cosine tie-break, apply the minimum-similarity cutoff, trim.
      const cutoff = minSimCutoff();
      hits = normalizeFallback(pool, cosineById)
        .filter((h) => (cosineById.get(h.chunk.id) ?? 1) >= cutoff)
        .slice(0, topK);
    }
  }

  if (opts.includeNeighbors) {
    for (const hit of hits) {
      hit.neighbors = await getNeighbors(hit.chunk.source_id, hit.chunk.chunk_index);
    }
  }

  return hits;
}
