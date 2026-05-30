// src/rag/__tests__/search.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  reciprocalRankFusion,
  brainSearch,
  buildWorkspaceScopeClause,
  __setSearchDepsForTest,
} from "../search.js";
import type { Chunk, SearchFilters } from "../types.js";

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

// --- F.1.4: brainSearch over-fetch -> rerank -> topK, real scores ----------
// Deps (searchSemantic/searchKeyword/embedQuery/rerankDocuments) are injected
// via the test seam, so these run WITHOUT POSTGRES_URL or VOYAGE_API_KEY.

afterEach(() => __setSearchDepsForTest(null));

const mkScored = (id: string, score: number, rank: number) => ({
  chunk: mk(id),
  rank,
  score,
});

test("brainSearch over-fetches max(30, topK*4) then reranks to topK", async () => {
  let semLimit = 0;
  __setSearchDepsForTest({
    searchSemantic: async (_e, _f, limit: number) => {
      semLimit = limit;
      return Array.from({ length: limit }, (_, i) =>
        mkScored(`s${i}`, 1 - i / limit, i + 1),
      );
    },
    searchKeyword: async (_q, _f, limit: number) =>
      Array.from({ length: limit }, (_, i) => mkScored(`k${i}`, 1 - i / limit, i + 1)),
    embedQuery: async () => [0.1, 0.2],
    rerankDocuments: async (_q, docs, topN) =>
      docs.slice(0, topN).map((d, i) => ({ id: d.id, relevance_score: 1 - i * 0.01 })),
  });

  const out = await brainSearch("q", { topK: 5, rerank: true });
  assert.ok(semLimit >= 30, `expected pool >=30, got ${semLimit}`);
  assert.equal(out.length, 5);
  assert.equal(out[0].score, 1); // reranker relevance_score, not 1/61
});

test("brainSearch rerank fallback uses normalized RRF score", async () => {
  __setSearchDepsForTest({
    searchSemantic: async (_e, _f, limit: number) =>
      Array.from({ length: limit }, (_, i) => mkScored(`s${i}`, 1 - i / limit, i + 1)),
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs, topN) =>
      docs.slice(0, topN).map((d) => ({ id: d.id, relevance_score: null })), // fallback
  });
  const out = await brainSearch("q", { topK: 3, rerank: true });
  assert.equal(out.length, 3);
  assert.ok(out[0].score >= out[1].score); // monotonic normalized score
  assert.ok(out[0].score <= 1 && out[0].score >= 0);
});

test("mode=semantic exposes cosine, not 1/rank", async () => {
  __setSearchDepsForTest({
    searchSemantic: async () => [mkScored("s0", 0.77, 1)],
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs) =>
      docs.map((d) => ({ id: d.id, relevance_score: null })),
  });
  const out = await brainSearch("q", { topK: 1, mode: "semantic" });
  assert.equal(out[0].score, 0.77);
});

test("rerank disabled: falls back to normalized RRF without calling reranker", async () => {
  let rerankCalled = false;
  __setSearchDepsForTest({
    searchSemantic: async (_e, _f, limit: number) =>
      Array.from({ length: limit }, (_, i) => mkScored(`s${i}`, 1 - i / limit, i + 1)),
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs, topN) => {
      rerankCalled = true;
      return docs.slice(0, topN).map((d) => ({ id: d.id, relevance_score: 0.5 }));
    },
  });
  const out = await brainSearch("q", { topK: 3, rerank: false });
  assert.equal(rerankCalled, false);
  assert.equal(out.length, 3);
  assert.ok(out[0].score <= 1 && out[0].score >= 0);
});

// --- F.4.2: workspace-scope enforcement -------------------------------------
// buildWorkspaceScopeClause is pure (no DB): forces WHERE workspace = ANY(...)
// from the caller's allowed workspaces, intersected with any caller filter.

test("scoped token -> WHERE workspace = ANY(...) (intersect caller)", () => {
  const { sql, params } = buildWorkspaceScopeClause(["personal"], { workspace: undefined });
  assert.match(sql, /workspace\s*=\s*ANY\(\$\d\)/i);
  assert.deepEqual(params, [["personal"]]);
});

test("scoped token + caller filter -> intersection only", () => {
  // caller asks globalcripto but token only allows personal -> empty intersection
  const { sql, params } = buildWorkspaceScopeClause(["personal"], { workspace: "globalcripto" });
  assert.deepEqual(params, [[]]); // empty -> zero rows, no leak
  assert.match(sql, /workspace\s*=\s*ANY\(\$\d\)/i);
});

test("scoped token + matching caller filter -> that single workspace", () => {
  const { sql, params } = buildWorkspaceScopeClause(
    ["personal", "globalcripto"],
    { workspace: "personal" },
  );
  assert.match(sql, /workspace\s*=\s*ANY\(\$\d\)/i);
  assert.deepEqual(params, [["personal"]]);
});

test("null allowed (all/cron) -> no clause", () => {
  const { sql, params } = buildWorkspaceScopeClause(null, { workspace: undefined });
  assert.equal(sql, "");
  assert.deepEqual(params, []);
});

test("null allowed but caller asked a workspace -> still no scope clause (caller filter handled separately)", () => {
  const { sql, params } = buildWorkspaceScopeClause(null, { workspace: "globalcripto" });
  assert.equal(sql, "");
  assert.deepEqual(params, []);
});

// startIdx is honored so the clause can be appended after embedding/topK params.
test("buildWorkspaceScopeClause honors startIdx for placeholder numbering", () => {
  const { sql } = buildWorkspaceScopeClause(["personal"], { workspace: undefined }, 4);
  assert.match(sql, /workspace\s*=\s*ANY\(\$4\)/i);
});

// --- F.4.2 acceptance: cross-workspace leak guard ---------------------------
// A personal-scoped token must yield ZERO globalcripto/nora chunks. We assert
// this end-to-end through brainSearch: the injected storage layer receives an
// effective allowed-workspace list of ["personal"] only, so any chunk it would
// otherwise return for globalcripto/nora is filtered out before it reaches the
// caller. We verify by inspecting the SearchFilters handed to storage.

test("brainSearch with personal-scoped token forces _allowedWorkspaces=['personal']", async () => {
  let semFilters: SearchFilters | undefined;
  __setSearchDepsForTest({
    getAllowedWorkspaces: () => ["personal"],
    searchSemantic: async (_e, filters, limit: number) => {
      semFilters = filters;
      return Array.from({ length: limit }, (_, i) => mkScored(`s${i}`, 1 - i / limit, i + 1));
    },
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs, topN) =>
      docs.slice(0, topN).map((d) => ({ id: d.id, relevance_score: null })),
  });
  await brainSearch("q", { topK: 3 });
  assert.deepEqual(semFilters?._allowedWorkspaces, ["personal"]);
});

test("brainSearch: personal token + caller asks globalcripto -> empty allowed set (no leak)", async () => {
  let semFilters: SearchFilters | undefined;
  __setSearchDepsForTest({
    getAllowedWorkspaces: () => ["personal"],
    searchSemantic: async (_e, filters, limit: number) => {
      semFilters = filters;
      return Array.from({ length: limit }, (_, i) => mkScored(`s${i}`, 1 - i / limit, i + 1));
    },
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs, topN) =>
      docs.slice(0, topN).map((d) => ({ id: d.id, relevance_score: null })),
  });
  await brainSearch("q", { topK: 3, filters: { workspace: "globalcripto" } });
  // empty intersection -> ANY('{}') -> zero rows; never another workspace.
  assert.deepEqual(semFilters?._allowedWorkspaces, []);
});

test("brainSearch with no context (null allowed) leaves _allowedWorkspaces undefined (unfiltered)", async () => {
  let semFilters: SearchFilters | undefined;
  __setSearchDepsForTest({
    getAllowedWorkspaces: () => null,
    searchSemantic: async (_e, filters, limit: number) => {
      semFilters = filters;
      return Array.from({ length: limit }, (_, i) => mkScored(`s${i}`, 1 - i / limit, i + 1));
    },
    searchKeyword: async () => [],
    embedQuery: async () => [0.1],
    rerankDocuments: async (_q, docs, topN) =>
      docs.slice(0, topN).map((d) => ({ id: d.id, relevance_score: null })),
  });
  await brainSearch("q", { topK: 3 });
  assert.equal(semFilters?._allowedWorkspaces, undefined);
});
