// src/rag/__tests__/search-utility.test.ts
// TDD spec 004 §3: utility boost in brainSearch, alpha=0 regression test
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  brainSearch,
  __setSearchDepsForTest,
} from "../search.js";
import type { Chunk } from "../types.js";

afterEach(() => __setSearchDepsForTest(null));

const mk = (id: string, utility = 0): Chunk => ({
  id,
  source_type: "notion",
  source_id: id,
  workspace: "personal",
  db_name: null,
  parent_url: null,
  chunk_index: 0,
  text: id,
  metadata: {},
  source_updated: null,
  utility_score: utility,
  feedback_count: 0,
  last_useful_at: null,
});

const mkScored = (id: string, score: number, rank: number, utility = 0) => ({
  chunk: mk(id, utility),
  rank,
  score,
});

// ---------------------------------------------------------------------------
// alpha=0 regression: ranking must be byte-for-byte identical to pre-spec
// ---------------------------------------------------------------------------

test("alpha=0: brainSearch ordering is identical to pre-utility ranking", async () => {
  // With UTILITY_ALPHA=0, the boost formula returns rerank_score unchanged.
  // The top-K order must match what would happen without utility.
  const originalEnv = process.env.UTILITY_ALPHA;
  process.env.UTILITY_ALPHA = "0";

  try {
    __setSearchDepsForTest({
      searchSemantic: async (_e, _f, limit: number) =>
        Array.from({ length: limit }, (_, i) =>
          mkScored(`s${i}`, 1 - i / limit, i + 1, /* utility varies */ i * 2),
        ),
      searchKeyword: async (_q, _f, limit: number) =>
        Array.from({ length: limit }, (_, i) => mkScored(`k${i}`, 1 - i / limit, i + 1)),
      embedQuery: async () => [0.1],
      rerankDocuments: async (_q, docs, topN) =>
        docs.slice(0, topN).map((d, i) => ({ id: d.id, relevance_score: 1 - i * 0.01 })),
    });

    const out = await brainSearch("q", { topK: 5, rerank: true });
    // The first result should have the highest rerank score (1.0)
    assert.equal(out[0].score, 1.0, "top score must match reranker score with alpha=0");
    // Ordering must be by reranker score descending
    for (let i = 0; i < out.length - 1; i++) {
      assert.ok(out[i].score >= out[i + 1].score, `ordering broken at index ${i}`);
    }
  } finally {
    if (originalEnv === undefined) delete process.env.UTILITY_ALPHA;
    else process.env.UTILITY_ALPHA = originalEnv;
  }
});

// ---------------------------------------------------------------------------
// alpha > 0: high-utility chunk gets boosted above equal-score neighbor
// ---------------------------------------------------------------------------

test("alpha=0.15: high-utility chunk rises above equal-score neighbor", async () => {
  const originalEnv = process.env.UTILITY_ALPHA;
  process.env.UTILITY_ALPHA = "0.15";

  try {
    // Two chunks: same rerank score, s0 has utility=0, s1 has utility=20
    // With boost: s1 gets final_score = 0.5 * (1 + 0.15 * tanh(20/10)) ≈ 0.5 * 1.149 > 0.5
    __setSearchDepsForTest({
      searchSemantic: async (_e, _f, limit: number) => [
        mkScored("s0", 0.5, 1, 0),   // utility=0
        mkScored("s1", 0.5, 2, 20),  // utility=20
      ].slice(0, limit),
      searchKeyword: async () => [],
      embedQuery: async () => [0.1],
      rerankDocuments: async (_q, docs, _topN) =>
        // Same relevance_score for both
        docs.map((d) => ({ id: d.id, relevance_score: 0.5 })),
    });

    const out = await brainSearch("q", { topK: 2, rerank: true });
    assert.equal(out.length, 2);
    // s1 (high utility) should come first
    assert.equal(out[0].chunk.id, "s1", `expected s1 first but got ${out[0].chunk.id}`);
  } finally {
    if (originalEnv === undefined) delete process.env.UTILITY_ALPHA;
    else process.env.UTILITY_ALPHA = originalEnv;
  }
});

// ---------------------------------------------------------------------------
// brain_search returns chunk_id in each result (aditivo)
// ---------------------------------------------------------------------------

test("brainSearch results include chunk.id accessible as chunk_id field", async () => {
  __setSearchDepsForTest({
    searchSemantic: async (_e, _f, limit: number) =>
      [mkScored("chunk-abc", 0.9, 1)].slice(0, limit),
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs, _topN) =>
      docs.map((d) => ({ id: d.id, relevance_score: 0.9 })),
  });

  const out = await brainSearch("q", { topK: 1, rerank: true });
  assert.equal(out.length, 1);
  // chunk_id is chunk.id — verify it's present
  assert.equal(out[0].chunk.id, "chunk-abc");
});
