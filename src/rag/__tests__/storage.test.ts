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
  buildFilterClauses,
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
  // F3.0: account_id is $2 (defaults to 'bruno'); workspace shifts to $3, liveIds $4.
  assert.match(sql, /account_id\s*=\s*\$2/i);
  assert.match(sql, /workspace\s*=\s*\$3/i);
  assert.match(sql, /source_id\s*<>\s*ALL\(\$4\)/i);
  assert.deepEqual(params, ["granola", "bruno", "personal", ["s1", "s2"]]);
});

test("pruneOrphans account-scopes by an explicit accountId when given", async () => {
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (_q: string, p: unknown[]) => {
      params = p;
      return { rowCount: 0, rows: [] };
    },
  } as never);
  await pruneOrphans("granola", "personal", ["s1"], "acme");
  assert.deepEqual(params, ["granola", "acme", "personal", ["s1"]]);
  __setPoolForTest(null);
});

// --- F3.0 account_id isolation guard (buildFilterClauses) --------------------

test("buildFilterClauses: _accountId emits account_id = $n (tenant guard)", () => {
  const { sql, params } = buildFilterClauses({ _accountId: "bruno" });
  assert.match(sql, /account_id\s*=\s*\$1/i);
  assert.deepEqual(params, ["bruno"]);
});

test("buildFilterClauses: _accountId AND _allowedWorkspaces both emitted (defense in depth)", () => {
  const { sql, params } = buildFilterClauses({
    _accountId: "bruno",
    _allowedWorkspaces: ["personal"],
  });
  assert.match(sql, /account_id\s*=\s*\$1/i);
  assert.match(sql, /workspace\s*=\s*ANY\(\$2\)/i);
  assert.deepEqual(params, ["bruno", ["personal"]]);
});

test("buildFilterClauses: no _accountId -> no account clause (unchanged for cron/eval)", () => {
  const { sql } = buildFilterClauses({ workspace: "personal" });
  assert.doesNotMatch(sql, /account_id/i);
});

test("buildFilterClauses: a second account's filter cannot select the first's rows", () => {
  const a = buildFilterClauses({ _accountId: "bruno" });
  const b = buildFilterClauses({ _accountId: "acme" });
  assert.deepEqual(a.params, ["bruno"]);
  assert.deepEqual(b.params, ["acme"]);
  // Same clause shape, different bound param -> SQL can never cross accounts.
  assert.equal(a.sql, b.sql);
});

test("pruneOrphans throws if granola/calendar called without workspace", async () => {
  await assert.rejects(
    () => pruneOrphans("granola", null, ["s1"]),
    /workspace required/i,
  );
});

// --- F.3.1: source_type / exclude_source_type filters -----------------------
// buildFilterClauses is pure (no DB) — runs WITHOUT POSTGRES_URL.

test("source_type produces equality clause", () => {
  const { sql, params } = buildFilterClauses({ source_type: "granola" });
  assert.match(sql, /source_type\s*=\s*\$\d/i);
  assert.ok(params.includes("granola"));
});

test("exclude_source_type produces inequality clause", () => {
  const { sql } = buildFilterClauses({ exclude_source_type: "calendar" });
  assert.match(sql, /source_type\s*(<>|!=)\s*\$\d/i);
});

// --- F.3.2: pessoa filter across real per-source shapes ---------------------

test("pessoa clause references pessoas + attendees with unaccent ILIKE", () => {
  const { sql, params } = buildFilterClauses({ pessoa: "João" });
  // both keys covered
  assert.match(sql, /metadata->'pessoas'/i);
  assert.match(sql, /metadata->'attendees'/i);
  // accent/partial-insensitive
  assert.match(sql, /unaccent/i);
  assert.match(sql, /ILIKE/i);
  assert.ok(
    params.some(
      (p) => String(p).toLowerCase().includes("joao") || String(p).includes("João"),
    ),
  );
});

test("pessoa clause does NOT reference contatos (dropped until populated)", () => {
  const { sql } = buildFilterClauses({ pessoa: "Maria" });
  assert.ok(!/contatos/i.test(sql));
});

// --- F.3.3: data filter COALESCE semantics + null inclusion -----------------

test("data filter uses COALESCE(metadata.data, source_updated)", () => {
  const { sql } = buildFilterClauses({ date_from: "2026-01-01", date_to: "2026-02-01" });
  assert.match(sql, /COALESCE\(\(metadata->>'data'\)::date,\s*source_updated::date\)/i);
});

test("no date filter -> no date clause (nulls included)", () => {
  const { sql } = buildFilterClauses({});
  assert.ok(!/metadata->>'data'/i.test(sql));
});

// --- F.4.2: workspace-scope enforcement reaches the SQL ---------------------
// buildFilterClauses must emit a hard `workspace = ANY($N)` clause whenever the
// caller threads an _allowedWorkspaces list (computed from the OAuth scope).
// This is the actual leak guard: a personal-scoped query can never return
// globalcripto/nora rows because the SQL itself restricts them.

test("_allowedWorkspaces emits workspace = ANY clause with the scoped array", () => {
  const { sql, params } = buildFilterClauses({ _allowedWorkspaces: ["personal"] });
  assert.match(sql, /workspace\s*=\s*ANY\(\$\d\)/i);
  assert.deepEqual(params, [["personal"]]);
});

test("_allowedWorkspaces empty array -> ANY('{}') -> zero rows (no leak)", () => {
  const { sql, params } = buildFilterClauses({ _allowedWorkspaces: [] });
  assert.match(sql, /workspace\s*=\s*ANY\(\$\d\)/i);
  assert.deepEqual(params, [[]]);
});

test("_allowedWorkspaces undefined -> no scope clause (unfiltered)", () => {
  const { sql } = buildFilterClauses({});
  assert.ok(!/ANY\(/i.test(sql));
});

test("_allowedWorkspaces coexists with caller workspace filter (both emitted)", () => {
  // caller workspace equality AND the hard scope ANY are both applied.
  const { sql, params } = buildFilterClauses({
    workspace: "personal",
    _allowedWorkspaces: ["personal"],
  });
  assert.match(sql, /workspace\s*=\s*\$\d/i); // caller equality
  assert.match(sql, /workspace\s*=\s*ANY\(\$\d\)/i); // hard scope
  assert.ok(params.includes("personal"));
  assert.ok(params.some((p) => Array.isArray(p) && p[0] === "personal"));
});
