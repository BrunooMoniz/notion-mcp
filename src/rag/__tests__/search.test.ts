// src/rag/__tests__/search.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFusion } from "../search.js";
import type { Chunk } from "../types.js";

const mk = (id: string): Chunk => ({
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
});

test("RRF combines two lists and ranks shared items higher", () => {
  const a = [mk("X"), mk("Y"), mk("Z")].map((c, i) => ({ chunk: c, rank: i + 1 }));
  const b = [mk("Y"), mk("W"), mk("X")].map((c, i) => ({ chunk: c, rank: i + 1 }));
  const out = reciprocalRankFusion([a, b], 4, 60);
  assert.equal(out[0].chunk.id, "Y");
  assert.equal(out[1].chunk.id, "X");
  assert.ok(out.length === 4);
});

test("RRF handles single list (passthrough order)", () => {
  const a = [mk("A"), mk("B"), mk("C")].map((c, i) => ({ chunk: c, rank: i + 1 }));
  const out = reciprocalRankFusion([a], 3, 60);
  assert.deepEqual(out.map((h) => h.chunk.id), ["A", "B", "C"]);
});

// --- F.1.3: pool size is parameterized (no pre-slice to a small topK) -------

test("reciprocalRankFusion returns up to poolSize candidates, not topK", () => {
  const sem = Array.from({ length: 20 }, (_, i) => mk(`s${i}`)).map((c, i) => ({
    chunk: c,
    rank: i + 1,
  }));
  const kw = Array.from({ length: 20 }, (_, i) => mk(`k${i}`)).map((c, i) => ({
    chunk: c,
    rank: i + 1,
  }));
  // 40 unique candidates, poolSize 30 -> capped to 30 (NOT a smaller topK).
  const fused = reciprocalRankFusion([sem, kw], 30, 60);
  assert.equal(fused.length, 30);
});

test("reciprocalRankFusion poolSize larger than candidates returns all", () => {
  const sem = [{ chunk: mk("a"), rank: 1 }];
  const kw = [{ chunk: mk("b"), rank: 1 }];
  const fused = reciprocalRankFusion([sem, kw], 30, 60);
  assert.equal(fused.length, 2);
});
