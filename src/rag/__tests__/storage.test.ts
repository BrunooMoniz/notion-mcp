// src/rag/__tests__/storage.test.ts
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  upsertChunks,
  replaceDocumentChunks,
  deleteBySource,
  getPool,
  closePool,
  searchSemantic,
  searchKeyword,
  pruneOrphans,
  buildFilterClauses,
  getNeighbors,
  getStatus,
  getBrainCounts,
  listBrainDocuments,
  titleFromHeaderLine,
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

// --- WS1: replaceDocumentChunks — transactional per-document replace ---------
// Proves the fix for the data-loss window. The per-account indexer used to delete
// every document up front and upsert ONCE at the end of a pass; an interruption
// emptied the brain. replaceDocumentChunks makes each document an atomic unit, so
// a crash can only lose the single in-flight document, never the whole brain.

function repChunk(sourceId: string, idx: number, accountId: string, text: string): ChunkWithEmbedding {
  return {
    id: `${accountId}:${sourceId}:${idx}`,
    source_type: "notion",
    source_id: sourceId,
    workspace: "personal",
    db_name: null,
    parent_url: null,
    chunk_index: idx,
    text,
    embedding: fakeEmbed(idx + 1),
    metadata: {},
    source_updated: new Date("2026-05-01"),
    account_id: accountId,
  };
}

test("replaceDocumentChunks swaps a document's chunks atomically (and prunes removed)", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const src = `${TEST_PREFIX}-replace-1`;
  const acct = "friend:replace-A";
  await upsertChunks([
    repChunk(src, 0, acct, "old a"),
    repChunk(src, 1, acct, "old b"),
    repChunk(src, 2, acct, "old c"),
  ]);
  // New version of the same document has only 2 chunks, with new text.
  await replaceDocumentChunks("notion", src, acct, [
    repChunk(src, 0, acct, "new a"),
    repChunk(src, 1, acct, "new b"),
  ]);
  const pool = getPool();
  const { rows } = await pool.query<{ chunk_index: number; text: string }>(
    `SELECT chunk_index, text FROM brain_chunks WHERE source_id=$1 AND account_id=$2 ORDER BY chunk_index`,
    [src, acct],
  );
  assert.equal(rows.length, 2); // the 3rd (old c) is gone
  assert.equal(rows[0].text, "new a");
  assert.equal(rows[1].text, "new b");
  await pool.query(`DELETE FROM brain_chunks WHERE source_id=$1`, [src]);
});

test("replaceDocumentChunks ROLLS BACK on a mid-insert failure, keeping old chunks", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const src = `${TEST_PREFIX}-replace-rollback`;
  const acct = "friend:replace-RB";
  await upsertChunks([repChunk(src, 0, acct, "keep a"), repChunk(src, 1, acct, "keep b")]);
  // The second new chunk has a wrong-dimension embedding: the INSERT fails AFTER
  // the DELETE and the first INSERT — exactly the window that used to corrupt data.
  const good = repChunk(src, 0, acct, "would-be-new");
  const bad = { ...repChunk(src, 1, acct, "bad"), embedding: [0.1, 0.2, 0.3] };
  await assert.rejects(replaceDocumentChunks("notion", src, acct, [good, bad]));
  const pool = getPool();
  const { rows } = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE source_id=$1 AND account_id=$2 ORDER BY chunk_index`,
    [src, acct],
  );
  // Transaction rolled back: the ORIGINAL two chunks survive; nothing was lost.
  assert.deepEqual(rows.map((r) => r.text), ["keep a", "keep b"]);
  await pool.query(`DELETE FROM brain_chunks WHERE source_id=$1`, [src]);
});

test("replaceDocumentChunks isolates by account_id (A's replace leaves B untouched)", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const src = `${TEST_PREFIX}-replace-iso`;
  const A = "friend:iso-A";
  const B = "friend:iso-B";
  // Two accounts indexing the SAME page (same source_id), distinct ids per account.
  await upsertChunks([repChunk(src, 0, A, "A old"), repChunk(src, 0, B, "B keep")]);
  await replaceDocumentChunks("notion", src, A, [repChunk(src, 0, A, "A new"), repChunk(src, 1, A, "A new2")]);
  const pool = getPool();
  const a = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE source_id=$1 AND account_id=$2 ORDER BY chunk_index`,
    [src, A],
  );
  const b = await pool.query<{ text: string }>(
    `SELECT text FROM brain_chunks WHERE source_id=$1 AND account_id=$2 ORDER BY chunk_index`,
    [src, B],
  );
  assert.deepEqual(a.rows.map((r) => r.text), ["A new", "A new2"]);
  assert.deepEqual(b.rows.map((r) => r.text), ["B keep"]); // account B never touched
  await pool.query(`DELETE FROM brain_chunks WHERE source_id=$1`, [src]);
});

// These two run WITHOUT POSTGRES_URL via an injected pool whose connect() returns
// a fake client that records the SQL verb of each statement — so CI verifies the
// transaction SEQUENCE (BEGIN→DELETE→INSERT…→COMMIT, and ROLLBACK on failure)
// even when no real Postgres is present.
test("replaceDocumentChunks issues BEGIN/DELETE/INSERT*/COMMIT in order (stub)", async () => {
  const calls: string[] = [];
  const fakeClient = {
    query: async (sql: string) => {
      calls.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  __setPoolForTest({
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => fakeClient,
  } as never);
  await replaceDocumentChunks("notion", "p1", "friend:X", [
    repChunk("p1", 0, "friend:X", "a"),
    repChunk("p1", 1, "friend:X", "b"),
  ]);
  // Fase 3 billing: for a NON-owner account the chunk cap reads the POST-DELETE
  // count inside the txn (the SELECT between DELETE and the INSERTs). The
  // reliability invariant is unchanged: DELETE before INSERTs, COMMIT only after.
  assert.deepEqual(calls, ["BEGIN", "DELETE", "SELECT", "INSERT", "INSERT", "COMMIT"]);
  __setPoolForTest(null);
});

test("replaceDocumentChunks ROLLS BACK and rethrows when an INSERT fails (stub)", async () => {
  const calls: string[] = [];
  let inserts = 0;
  const fakeClient = {
    query: async (sql: string) => {
      const verb = String(sql).trim().split(/\s+/)[0].toUpperCase();
      calls.push(verb);
      if (verb === "INSERT" && ++inserts === 2) throw new Error("insert boom");
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  __setPoolForTest({
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => fakeClient,
  } as never);
  await assert.rejects(
    replaceDocumentChunks("notion", "p1", "friend:X", [
      repChunk("p1", 0, "friend:X", "a"),
      repChunk("p1", 1, "friend:X", "b"),
    ]),
    /insert boom/,
  );
  // DELETE ran, billing cap SELECT, first INSERT ok, second INSERT threw ->
  // ROLLBACK, never COMMIT.
  assert.deepEqual(calls, ["BEGIN", "DELETE", "SELECT", "INSERT", "INSERT", "ROLLBACK"]);
  __setPoolForTest(null);
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

// --- F3.0 getNeighbors account/workspace scoping (fix M1) -------------------

test("getNeighbors scopes by account_id and workspace (no cross-tenant neighbor leak)", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await getNeighbors("src-1", 5, "bruno", "personal");
  assert.match(sql, /source_id=\$1/i);
  assert.match(sql, /chunk_index IN \(\$2, \$3\)/i);
  assert.match(sql, /account_id=\$4/i);
  assert.match(sql, /workspace IS NOT DISTINCT FROM \$5/i);
  assert.deepEqual(params, ["src-1", 4, 6, "bruno", "personal"]);
  __setPoolForTest(null);
});

test("getNeighbors defaults accountId to 'bruno' and omits workspace clause when not given", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await getNeighbors("src-9", 2);
  assert.match(sql, /account_id=\$4/i);
  // 'workspace' appears in the SELECT column list; assert no WHERE workspace clause.
  assert.doesNotMatch(sql, /IS NOT DISTINCT FROM/i);
  assert.deepEqual(params, ["src-9", 1, 3, "bruno"]);
  __setPoolForTest(null);
});

// --- F3.0 metering wiring + getStatus account scope -------------------------

test("upsertChunks meters 'chunks' to usage_log (wiring proof)", async () => {
  const sqls: string[] = [];
  const allParams: unknown[][] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sqls.push(q);
      allParams.push(p);
      return { rows: [], rowCount: 1 };
    },
  } as never);
  const chunk: ChunkWithEmbedding = {
    id: "u1",
    source_type: "web",
    source_id: "s",
    workspace: "personal",
    db_name: null,
    parent_url: null,
    chunk_index: 0,
    text: "t",
    embedding: [0.1, 0.2],
    metadata: {},
    source_updated: null,
  };
  await upsertChunks([chunk]);
  const usageIdx = sqls.findIndex((s) => /INSERT INTO usage_log/i.test(s));
  assert.ok(usageIdx >= 0, "expected a usage_log INSERT from upsertChunks");
  assert.deepEqual(allParams[usageIdx], ["bruno", "chunks", 1]);
  __setPoolForTest(null);
});

test("getStatus scopes status_runs and the sync_state join by account_id", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await getStatus();
  assert.match(sql, /FROM status_runs\s+WHERE account_id = \$1/i);
  assert.match(sql, /ss\.account_id = \$1/i);
  assert.deepEqual(params, ["bruno"]);
  __setPoolForTest(null);
});

// --- WS3: brain counts + document navigation (account-scoped) ---------------

test("titleFromHeaderLine strips the provenance bracket to recover the title", () => {
  assert.equal(titleFromHeaderLine("[Reuniões · personal · 2026-06-04] Sync de Produto"), "Sync de Produto");
  assert.equal(titleFromHeaderLine("Sem colchete vira o título"), "Sem colchete vira o título");
  assert.equal(titleFromHeaderLine("[só o bracket]"), "[só o bracket]"); // nothing after -> keep raw
  assert.equal(titleFromHeaderLine(""), "");
  assert.equal(titleFromHeaderLine(null), "");
});

// Build a chunk whose first line is a context header (as index-document stores it).
function navChunk(sourceId, idx, accountId, opts) {
  const header = `[${opts.db || "DB"} · ${opts.ws || "personal"}${opts.date ? " · " + opts.date : ""}] ${opts.title}`;
  return {
    id: `${accountId}:${sourceId}:${idx}`,
    source_type: opts.source_type || "notion",
    source_id: sourceId,
    workspace: opts.ws || "personal",
    db_name: opts.db || null,
    parent_url: opts.url || null,
    chunk_index: idx,
    text: `${header}\n\n${opts.body || "conteúdo"}`,
    embedding: fakeEmbed(idx + 1),
    metadata: opts.date ? { data: opts.date } : {},
    source_updated: new Date("2026-05-01"),
    account_id: accountId,
  };
}

test("getBrainCounts aggregates per source_type and isolates by account", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const A = "friend:counts-A";
  const B = "friend:counts-B";
  const sa = `${TEST_PREFIX}-cnt`;
  await upsertChunks([
    navChunk(`${sa}-n1`, 0, A, { source_type: "notion", title: "N1" }),
    navChunk(`${sa}-n1`, 1, A, { source_type: "notion", title: "N1" }),
    navChunk(`${sa}-n2`, 0, A, { source_type: "notion", title: "N2" }),
    navChunk(`${sa}-g1`, 0, A, { source_type: "granola", title: "G1" }),
    navChunk(`${sa}-nB`, 0, B, { source_type: "notion", title: "B's" }),
  ]);
  const c = await getBrainCounts(A);
  const notion = c.bySource.find((s) => s.source_type === "notion");
  const granola = c.bySource.find((s) => s.source_type === "granola");
  assert.equal(notion.documents, 2); // n1, n2 (distinct source_id)
  assert.equal(notion.chunks, 3); // 2 + 1
  assert.equal(granola.documents, 1);
  assert.equal(c.totals.documents, 3); // B's doc is NOT counted for A
  assert.equal(c.totals.chunks, 4);
  await getPool().query(`DELETE FROM brain_chunks WHERE source_id LIKE $1`, [`${sa}%`]);
});

test("listBrainDocuments returns one row per document with title from the header, account-scoped", async () => {
  if (!HAS_PG) {
    console.log("skipping: no POSTGRES_URL");
    return;
  }
  const A = "friend:list-A";
  const B = "friend:list-B";
  const sa = `${TEST_PREFIX}-list`;
  await upsertChunks([
    navChunk(`${sa}-doc1`, 0, A, { title: "Plano de Lançamento", db: "Projetos", date: "2026-06-04", url: "https://notion.so/doc1" }),
    navChunk(`${sa}-doc1`, 1, A, { title: "Plano de Lançamento", db: "Projetos", date: "2026-06-04" }),
    navChunk(`${sa}-doc2`, 0, A, { source_type: "granola", title: "1:1 com Marina", date: "2026-06-05" }),
    navChunk(`${sa}-docB`, 0, B, { title: "Coisa da conta B" }),
  ]);
  const docs = await listBrainDocuments(A, {});
  const ids = docs.map((d) => d.source_id);
  assert.ok(!ids.includes(`${sa}-docB`)); // account B never leaks
  const doc1 = docs.find((d) => d.source_id === `${sa}-doc1`);
  assert.equal(doc1.title, "Plano de Lançamento"); // ONE row, title from header, bracket stripped
  assert.equal(doc1.parent_url, "https://notion.so/doc1");
  assert.equal(doc1.doc_date, "2026-06-04");
  assert.equal(docs.filter((d) => d.source_id === `${sa}-doc1`).length, 1); // distinct

  // source_type filter
  const onlyGranola = await listBrainDocuments(A, { sourceType: "granola" });
  assert.deepEqual(onlyGranola.map((d) => d.title).sort(), ["1:1 com Marina"]);

  // ILIKE q filter (matches header/title)
  const q = await listBrainDocuments(A, { q: "Marina" });
  assert.deepEqual(q.map((d) => d.title), ["1:1 com Marina"]);

  await getPool().query(`DELETE FROM brain_chunks WHERE source_id LIKE $1`, [`${sa}%`]);
});
