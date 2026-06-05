// src/rag/__tests__/index-account.test.ts
// F3.2b — isolation primitive: prefixChunkIds namespaces chunk ids by account so
// two accounts indexing the same Notion page never collide on the brain_chunks PK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefixChunkIds } from "../account-chunks.js";
import type { ChunkWithEmbedding } from "../types.js";

function chunk(id: string): ChunkWithEmbedding {
  return {
    id,
    source_type: "notion",
    source_id: "page-1",
    workspace: "ws-1",
    db_name: null,
    parent_url: null,
    chunk_index: 0,
    text: "t",
    embedding: [0.1],
    metadata: {},
    source_updated: null,
  };
}

test("prefixChunkIds namespaces id and sets account_id", () => {
  const out = prefixChunkIds([chunk("abc"), chunk("def")], "notion:ws-1");
  assert.deepEqual(out.map((c) => c.id), ["notion:ws-1:abc", "notion:ws-1:def"]);
  assert.ok(out.every((c) => c.account_id === "notion:ws-1"));
});

test("two accounts indexing the same page get distinct ids (no PK collision)", () => {
  const a = prefixChunkIds([chunk("samehash")], "notion:A")[0];
  const b = prefixChunkIds([chunk("samehash")], "notion:B")[0];
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, "notion:A:samehash");
  assert.equal(b.id, "notion:B:samehash");
});
