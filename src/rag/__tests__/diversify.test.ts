// src/rag/__tests__/diversify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { diversifyHits } from "../search.js";
import type { Chunk, SearchHit } from "../types.js";

// Minimal SearchHit fixture: only the fields diversifyHits reads
// (chunk.text, chunk.parent_url) plus the required score.
const mk = (
  id: string,
  opts: { text?: string; parent_url?: string | null } = {},
): SearchHit => {
  const chunk = {
    id,
    text: opts.text ?? id,
    parent_url: opts.parent_url ?? null,
  } as unknown as Chunk;
  return { chunk, score: 1 };
};

const ids = (hits: SearchHit[]) => hits.map((h) => h.chunk.id);

test("drops a hit with identical text to one already kept (keeps first)", () => {
  const hits = [
    mk("a", { text: "same body", parent_url: "u1" }),
    mk("b", { text: "same body", parent_url: "u2" }), // exact-duplicate text
  ];
  const out = diversifyHits(hits, { topK: 10, maxPerUrl: 3 });
  assert.deepEqual(ids(out), ["a"]);
});

test("dedup ignores leading/trailing whitespace when comparing text", () => {
  const hits = [
    mk("a", { text: "hello world" }),
    mk("b", { text: "  hello world  " }), // identical after trim
  ];
  const out = diversifyHits(hits, { topK: 10 });
  assert.deepEqual(ids(out), ["a"]);
});

test("caps at maxPerUrl=3 for the same parent_url (5 in -> 3 kept)", () => {
  const hits = Array.from({ length: 5 }, (_, i) =>
    mk(`h${i}`, { text: `body ${i}`, parent_url: "https://same/page" }),
  );
  const out = diversifyHits(hits, { topK: 10, maxPerUrl: 3 });
  assert.equal(out.length, 3);
  assert.deepEqual(ids(out), ["h0", "h1", "h2"]); // first three survive
});

test("preserves order and respects topK", () => {
  const hits = [
    mk("a", { text: "ta", parent_url: "u1" }),
    mk("b", { text: "tb", parent_url: "u2" }),
    mk("c", { text: "tc", parent_url: "u3" }),
    mk("d", { text: "td", parent_url: "u4" }),
  ];
  const out = diversifyHits(hits, { topK: 2, maxPerUrl: 3 });
  assert.equal(out.length, 2);
  assert.deepEqual(ids(out), ["a", "b"]); // ranked order kept, truncated to topK
});

test("null/empty parent_url is un-capped (distinct unknown-origin chunks not collapsed)", () => {
  const hits = [
    mk("a", { text: "t1", parent_url: null }),
    mk("b", { text: "t2", parent_url: null }),
    mk("c", { text: "t3", parent_url: null }),
    mk("d", { text: "t4", parent_url: null }),
    mk("e", { text: "t5", parent_url: "" }), // empty string also un-capped
  ];
  const out = diversifyHits(hits, { topK: 10, maxPerUrl: 3 });
  // No url cap applied to null/empty parent_url -> all distinct-text hits kept.
  assert.equal(out.length, 5);
  assert.deepEqual(ids(out), ["a", "b", "c", "d", "e"]);
});

test("defaults maxPerUrl to 3 when omitted", () => {
  const hits = Array.from({ length: 4 }, (_, i) =>
    mk(`h${i}`, { text: `body ${i}`, parent_url: "u1" }),
  );
  const out = diversifyHits(hits, { topK: 10 });
  assert.equal(out.length, 3);
});
