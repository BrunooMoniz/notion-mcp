// src/rag/__tests__/run-eval.test.ts
// NOTE: per repo test convention, unit tests live in src/rag/__tests__/ so the
// `npm test` glob (src/rag/__tests__/*.test.ts) runs them. The unit under test
// is the pure metric math exported from scripts/eval/run-eval.mts (the runner).
// NodeNext resolves the .mts module via its .mjs runtime specifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recallAtK, mrr, aggregate, recallAtKSub, mrrSub } from "../../../scripts/eval/run-eval.mjs";

test("recallAtK: hit within k", () => {
  // expected ids B, top-k results A,B,C at k=3 -> 1 of 1 expected found
  assert.equal(recallAtK(["A", "B", "C"], ["B"], 3), 1);
});

test("recallAtK: miss beyond k", () => {
  // expected D, results A,B,C,D ; at k=3 D is not in top-3 -> 0
  assert.equal(recallAtK(["A", "B", "C", "D"], ["D"], 3), 0);
});

test("recallAtK: partial multi-expected", () => {
  // expected B & E, top-4 A,B,C,D -> only B found -> 0.5
  assert.equal(recallAtK(["A", "B", "C", "D"], ["B", "E"], 4), 0.5);
});

test("recallAtK: empty expected returns 1 (vacuously satisfied)", () => {
  assert.equal(recallAtK(["A", "B"], [], 5), 1);
});

test("mrr: first relevant at rank 2 -> 1/2", () => {
  assert.equal(mrr(["A", "B", "C"], ["B"]), 0.5);
});

test("mrr: first relevant at rank 1 -> 1", () => {
  assert.equal(mrr(["B", "A"], ["B"]), 1);
});

test("mrr: no relevant -> 0", () => {
  assert.equal(mrr(["A", "C"], ["B"]), 0);
});

test("recallAtKSub: substring match within k", () => {
  // expected page-id 'abc123' appears in url[1] within k=3 -> 1/1
  const urls = ["https://x/p/Other-zzz", "https://x/p/Talos-abc123", "https://x/p/More-yyy"];
  assert.equal(recallAtKSub(urls, ["abc123"], 3), 1);
});

test("recallAtKSub: substring beyond k -> 0", () => {
  const urls = ["a", "b", "c", "https://x/p/T-abc123"];
  assert.equal(recallAtKSub(urls, ["abc123"], 3), 0);
});

test("mrrSub: first url containing the substring sets the rank", () => {
  const urls = ["https://x/p/Other-zzz", "https://x/p/Talos-abc123"];
  assert.equal(mrrSub(urls, ["abc123"]), 0.5);
  assert.equal(mrrSub(urls, ["nope"]), 0);
});

test("aggregate: averages per-question metrics", () => {
  const rows = [
    { recall_at_5: 1, mrr: 1 },
    { recall_at_5: 0, mrr: 0 },
  ];
  const agg = aggregate(rows);
  assert.equal(agg.recall_at_5, 0.5);
  assert.equal(agg.mrr, 0.5);
});
