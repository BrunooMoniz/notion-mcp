// src/rag/__tests__/storage.test.ts
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  upsertChunks,
  deleteBySource,
  getPool,
  closePool,
  searchSemantic,
  searchKeyword,
  pruneOrphans,
  __setPoolForTest,
} from "../storage.js";
import type { ChunkWithEmbedding } from "../types.js";

const TEST_PREFIX = "__test_storage__";

function fakeEmbed(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed * (i + 1)) * 0.01);
}

const HAS_PG = Boolean(process.env.POSTGRES_URL);

before(async () => {
  if (!HAS_PG) return;
  const pool = getPool();
  await pool.query(`DELETE FROM brain_chunks WHERE source_id LIKE $1`, [`${TEST_PREFIX}%`]);
});

after(async () => {
  if (!HAS_PG) return;
  const pool = getPool();
  await pool.query(`DELETE FROM brain_chunks WHERE source_id LIKE $1`, [`${TEST_PREFIX}%`]);
  await closePool();
});

test("upsertChunks inserts and re-upsert updates", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const chunk: ChunkWithEmbedding = {
    id: `${TEST_PREFIX}-id-0`,
    source_type: "notion",
    source_id: `${TEST_PREFIX}-page-1`,
    workspace: "personal",
    db_name: "Reunioes",
    parent_url: "https://notion.so/foo",
    chunk_index: 0,
    text: "primeiro texto",
    embedding: fakeEmbed(1),
    metadata: { frente: "Global Cripto" },
    source_updated: new Date("2026-04-20"),
  };
  await upsertChunks([chunk]);
  const pool = getPool();
  const r1 = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE id=$1`,
    [chunk.id],
  );
  assert.equal(r1.rows[0].text, "primeiro texto");

  await upsertChunks([{ ...chunk, text: "texto atualizado" }]);
  const r2 = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE id=$1`,
    [chunk.id],
  );
  assert.equal(r2.rows[0].text, "texto atualizado");
});

test("deleteBySource removes all chunks for a source", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const sourceId = `${TEST_PREFIX}-page-2`;
  const chunks: ChunkWithEmbedding[] = [0, 1, 2].map((i) => ({
    id: `${TEST_PREFIX}-multi-${i}`,
    source_type: "notion",
    source_id: sourceId,
    workspace: "personal",
    db_name: null,
    parent_url: null,
    chunk_index: i,
    text: `chunk ${i}`,
    embedding: fakeEmbed(i + 10),
    metadata: {},
    source_updated: new Date(),
  }));
  await upsertChunks(chunks);
  await deleteBySource("notion", sourceId);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT count(*) FROM brain_chunks WHERE source_id=$1`,
    [sourceId],
  );
  assert.equal(rows[0].count, "0");
});

// --- F.1.2: searchSemantic/searchKeyword expose real scores ----------------
// These run WITHOUT POSTGRES_URL: the pool is replaced with a stub via the
// __setPoolForTest seam, so no live DB is touched.

afterEach(() => {
  // Clear any injected stub so the credentialed tests above are unaffected.
  __setPoolForTest(null);
});

test("searchSemantic returns cosine score (exposed as score field)", async () => {
  __setPoolForTest({
    query: async () => ({
      rows: [
        {
          id: "id1",
          source_type: "notion",
          source_id: "s1",
          workspace: "personal",
          db_name: null,
          parent_url: null,
          chunk_index: 0,
          text: "t",
          metadata: {},
          source_updated: null,
          score: 0.82,
        },
      ],
    }),
  });
  const out = await searchSemantic([0.1, 0.2], undefined, 5);
  assert.equal(out[0].score, 0.82);
  assert.equal(out[0].chunk.source_id, "s1");
});

test("searchKeyword returns ts_rank score (exposed as score field)", async () => {
  __setPoolForTest({
    query: async () => ({
      rows: [
        {
          id: "id2",
          source_type: "notion",
          source_id: "s2",
          workspace: "personal",
          db_name: null,
          parent_url: null,
          chunk_index: 0,
          text: "t",
          metadata: {},
          source_updated: null,
          score: 0.31,
        },
      ],
    }),
  });
  const out = await searchKeyword("query", undefined, 5);
  assert.equal(out[0].score, 0.31);
  assert.equal(out[0].chunk.source_id, "s2");
});

// --- F.2.2: pruneOrphans namespace-safe deletes -----------------------------
// These run WITHOUT POSTGRES_URL via the __setPoolForTest seam.

test("pruneOrphans scopes DELETE by source_type AND workspace", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rowCount: 2, rows: [] };
    },
  } as never);
  const deleted = await pruneOrphans("granola", "personal", ["s1", "s2"]);
  assert.equal(deleted, 2);
  assert.match(sql, /source_type\s*=\s*\$1/i);
  assert.match(sql, /workspace\s*=\s*\$2/i);
  assert.match(sql, /source_id\s*<>\s*ALL\(\$3\)/i);
  assert.deepEqual(params, ["granola", "personal", ["s1", "s2"]]);
});

test("pruneOrphans throws if granola/calendar called without workspace", async () => {
  await assert.rejects(
    () => pruneOrphans("granola", null, ["s1"]),
    /workspace required/i,
  );
});
