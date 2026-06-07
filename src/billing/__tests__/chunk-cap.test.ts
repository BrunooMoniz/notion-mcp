// src/billing/__tests__/chunk-cap.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { upsertChunks, replaceDocumentChunks, __setPoolForTest } from "../../rag/storage.js";
import { QuotaExceededError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import type { ChunkWithEmbedding } from "../../rag/types.js";

function chunk(id: string, accountId: string): ChunkWithEmbedding {
  return {
    id, source_type: "notion", source_id: "s", workspace: "personal",
    db_name: null, parent_url: null, chunk_index: 0, text: "t",
    embedding: Array.from({ length: 1024 }, () => 0.001),
    metadata: {}, source_updated: null, account_id: accountId,
  } as ChunkWithEmbedding;
}

function memPool(plan: string, chunkCount: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) return { rows: [{ n: String(chunkCount) }] };
      return { rows: [], rowCount: 0 }; // INSERTs
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("friend at chunk cap -> upsertChunks throws QuotaExceededError", async () => {
  __setPoolForTest(memPool("free", 2000) as never); // already at 2000 cap
  await assert.rejects(() => upsertChunks([chunk("a", "friend:1")]), QuotaExceededError);
});

test("owner/default account -> upsertChunks never checks the cap", async () => {
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) throw new Error("must not check plan for owner");
      return { rows: [], rowCount: 0 };
    },
  } as never);
  await upsertChunks([chunk("a", "bruno")]); // no throw
});

// replaceDocumentChunks is the PRIMARY per-account indexing path (portal reindex,
// onboarding, auto re-sync). It must enforce the cap too — checked POST-DELETE.
test("friend over chunk cap -> replaceDocumentChunks throws (post-delete count)", async () => {
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan: "free" }] };
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) return { rows: [{ n: "2000" }] }; // post-delete already at cap
      return { rows: [], rowCount: 0 }; // DELETE / INSERT
    },
  } as never);
  await assert.rejects(
    () => replaceDocumentChunks("notion", "doc1", "friend:1", [chunk("a", "friend:1")]),
    QuotaExceededError,
  );
});

test("re-indexing a same-size doc near cap is NOT false-blocked (post-delete count)", async () => {
  // total before = 2000 (at cap), this doc had 1 chunk; post-delete count = 1999;
  // 1999 + 1 = 2000 == cap -> allowed.
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan: "free" }] };
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) return { rows: [{ n: "1999" }] };
      return { rows: [], rowCount: 0 };
    },
  } as never);
  await replaceDocumentChunks("notion", "doc1", "friend:1", [chunk("a", "friend:1")]); // no throw
});

test("owner/default -> replaceDocumentChunks never checks the cap", async () => {
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) throw new Error("must not check plan for owner");
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) throw new Error("must not count for owner");
      return { rows: [], rowCount: 0 };
    },
  } as never);
  await replaceDocumentChunks("notion", "doc1", "bruno", [chunk("a", "bruno")]); // no throw
});
