// src/rag/__tests__/rerank.test.ts
// NOTE: per repo test convention, unit tests live in src/rag/__tests__/ so the
// `npm test` glob (src/rag/__tests__/*.test.ts) runs them. The unit under test
// is the Voyage rerank wrapper exported from src/rag/rerank.ts.
// Fetch is MOCKED — no live Voyage call, runs without VOYAGE_API_KEY in CI.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rerankDocuments, rerankEnabled } from "../rerank.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RERANK_ENABLED;
  delete process.env.VOYAGE_API_KEY;
});
beforeEach(() => {
  process.env.VOYAGE_API_KEY = "test-key";
});

test("maps Voyage response by index back to caller ids", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 },
        ],
        usage: { total_tokens: 10 },
      }),
      { status: 200 },
    )) as typeof fetch;

  const docs = [
    { id: "a", text: "doc a" },
    { id: "b", text: "doc b" },
    { id: "c", text: "doc c" },
  ];
  const out = await rerankDocuments("q", docs, 2);
  assert.deepEqual(out, [
    { id: "c", relevance_score: 0.9 },
    { id: "a", relevance_score: 0.4 },
  ]);
});

test("sends documents as plain strings and top_k", async () => {
  let captured: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ data: [], usage: {} }), { status: 200 });
  }) as typeof fetch;

  await rerankDocuments("hello", [{ id: "x", text: "tx" }], 5);
  assert.equal(captured.query, "hello");
  assert.deepEqual(captured.documents, ["tx"]);
  assert.equal(captured.top_k, 5);
  assert.equal(captured.model, "rerank-2.5-lite");
});

test("graceful fallback: on non-200 returns input order with null scores", async () => {
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as typeof fetch;

  const docs = [
    { id: "a", text: "ta" },
    { id: "b", text: "tb" },
  ];
  const out = await rerankDocuments("q", docs, 2, undefined, { retries: 0 });
  assert.deepEqual(out, [
    { id: "a", relevance_score: null },
    { id: "b", relevance_score: null },
  ]);
});

test("env kill-switch: RERANK_ENABLED=false disables regardless of opt", () => {
  process.env.RERANK_ENABLED = "false";
  assert.equal(rerankEnabled(true), false);
  assert.equal(rerankEnabled(undefined), false);
});

test("env on (default): per-call opt governs; default true", () => {
  delete process.env.RERANK_ENABLED;
  assert.equal(rerankEnabled(undefined), true);
  assert.equal(rerankEnabled(false), false);
  assert.equal(rerankEnabled(true), true);
});

test("env on explicitly: opt=true reranks, opt=false off", () => {
  process.env.RERANK_ENABLED = "true";
  assert.equal(rerankEnabled(true), true);
  assert.equal(rerankEnabled(false), false);
});
