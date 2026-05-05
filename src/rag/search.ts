// src/rag/search.ts
import {
  searchSemantic,
  searchKeyword,
  getNeighbors,
} from "./storage.js";
import { embedQuery } from "./embeddings.js";
import type { Chunk, SearchFilters, SearchHit, SearchMode } from "./types.js";

export interface RankedChunk {
  chunk: Chunk;
  rank: number;
}

export function reciprocalRankFusion(
  lists: RankedChunk[][],
  topK: number,
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
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => ({ chunk: s.chunk, score: s.score }));
}

export interface SearchOptions {
  topK?: number;
  mode?: SearchMode;
  filters?: SearchFilters;
  includeNeighbors?: boolean;
}

export async function brainSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 12;
  const mode = opts.mode ?? "hybrid";

  let hits: SearchHit[] = [];

  if (mode === "semantic" || mode === "hybrid") {
    const qEmbed = await embedQuery(query);
    const semHits = await searchSemantic(qEmbed, opts.filters, topK * 3);
    if (mode === "semantic") {
      hits = semHits.slice(0, topK).map((h) => ({ chunk: h.chunk, score: 1 / h.rank }));
    } else {
      const kwHits = await searchKeyword(query, opts.filters, topK * 3);
      hits = reciprocalRankFusion([semHits, kwHits], topK);
    }
  } else {
    const kwHits = await searchKeyword(query, opts.filters, topK);
    hits = kwHits.map((h) => ({ chunk: h.chunk, score: 1 / h.rank }));
  }

  if (opts.includeNeighbors) {
    for (const hit of hits) {
      hit.neighbors = await getNeighbors(hit.chunk.source_id, hit.chunk.chunk_index);
    }
  }

  return hits;
}
