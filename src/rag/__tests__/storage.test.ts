// src/rag/__tests__/storage.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { upsertChunks, deleteBySource, getPool, closePool } from "../storage.js";
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
