// src/rag/__tests__/facts-storage.test.ts
// F2.3 — DB layer for temporal facts. NO live DB: a stub pool is injected via
// the __setPoolForTest seam from storage.ts (facts-storage reuses getPool() from
// the same module), capturing query(sql, params) so we can assert the SQL/param
// shape without Postgres.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import { insertFacts, queryFacts, deleteFactsBySource } from "../facts-storage.js";
import type { Fact } from "../facts.js";

afterEach(() => {
  __setPoolForTest(null);
});

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    subject: "Bruno",
    predicate: "é sócio de",
    object: "Nora",
    workspace: "personal",
    source_id: "page-1",
    source_type: "reuniao",
    confidence: 0.9,
    valid_from: "2026-01-01",
    valid_to: null,
    ...overrides,
  };
}

// --- insertFacts ------------------------------------------------------------

test("insertFacts is a no-op (returns 0) on empty input, issues no query", async () => {
  let called = false;
  __setPoolForTest({
    query: async () => {
      called = true;
      return { rows: [], rowCount: 0 };
    },
  } as never);
  const n = await insertFacts([]);
  assert.equal(n, 0);
  assert.equal(called, false);
});

test("insertFacts emits one INSERT with all params for a single fact", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [], rowCount: 1 };
    },
  } as never);

  const f = fact();
  const n = await insertFacts([f]);
  assert.equal(n, 1);
  assert.match(sql, /INSERT INTO brain_facts/i);
  assert.match(sql, /subject, predicate, object/i);
  // 10 columns -> 10 params for one row
  assert.equal(params.length, 10);
  assert.deepEqual(params.slice(0, 7), [
    "Bruno",
    "é sócio de",
    "Nora",
    "personal",
    "page-1",
    "reuniao",
    0.9,
  ]);
  assert.equal(params[7], "2026-01-01"); // valid_from
  assert.equal(params[8], null); // valid_to
  assert.equal(params[9], null); // metadata (undefined -> null)
});

test("insertFacts batches multiple facts into one query with sequential placeholders", async () => {
  let sql = "";
  let params: unknown[] = [];
  let queryCount = 0;
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      queryCount++;
      sql = q;
      params = p;
      return { rows: [], rowCount: 3 };
    },
  } as never);

  const facts = [fact({ subject: "A" }), fact({ subject: "B" }), fact({ subject: "C" })];
  const n = await insertFacts(facts);
  assert.equal(n, 3);
  assert.equal(queryCount, 1); // single batched INSERT
  assert.equal(params.length, 30); // 3 rows * 10 cols
  // placeholders run $1..$30, last row starts at $21
  assert.match(sql, /\$21,\s*\$22/);
  assert.match(sql, /\$30::jsonb\)/);
  assert.equal(params[0], "A");
  assert.equal(params[10], "B");
  assert.equal(params[20], "C");
});

test("insertFacts serializes object metadata to JSON", async () => {
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (_q: string, p: unknown[]) => {
      params = p;
      return { rows: [], rowCount: 1 };
    },
  } as never);
  await insertFacts([fact({ metadata: { src: "x" } })]);
  assert.equal(params[9], JSON.stringify({ src: "x" }));
});

// --- queryFacts -------------------------------------------------------------

test("queryFacts with no opts: no WHERE, default limit 50", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await queryFacts();
  assert.ok(!/WHERE/i.test(sql));
  assert.match(sql, /LIMIT \$1/i);
  assert.deepEqual(params, [50]);
});

test("queryFacts subject uses case-insensitive lower() equality", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await queryFacts({ subject: "Bruno" });
  assert.match(sql, /lower\(subject\)\s*=\s*lower\(\$1\)/i);
  assert.deepEqual(params, ["Bruno", 50]);
});

test("queryFacts predicate uses case-insensitive lower() equality", async () => {
  let sql = "";
  __setPoolForTest({
    query: async (q: string) => {
      sql = q;
      return { rows: [] };
    },
  } as never);
  await queryFacts({ predicate: "role" });
  assert.match(sql, /lower\(predicate\)\s*=\s*lower\(\$1\)/i);
});

test("queryFacts workspace uses equality", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await queryFacts({ workspace: "personal" });
  assert.match(sql, /workspace\s*=\s*\$1/i);
  assert.deepEqual(params, ["personal", 50]);
});

test("queryFacts activeOn emits the validity-window clause with one reused param", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await queryFacts({ activeOn: "2026-03-15" });
  // valid_from <= D AND (valid_to IS NULL OR valid_to >= D), reusing $1
  assert.match(sql, /valid_from\s+IS\s+NULL\s+OR\s+valid_from\s*<=\s*\$1::date/i);
  assert.match(sql, /valid_to\s+IS\s+NULL\s+OR\s+valid_to\s*>=\s*\$1::date/i);
  assert.deepEqual(params, ["2026-03-15", 50]);
});

test("queryFacts combines all filters with sequential params and custom limit", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [] };
    },
  } as never);
  await queryFacts({
    subject: "Bruno",
    predicate: "role",
    workspace: "personal",
    activeOn: "2026-03-15",
    limit: 10,
  });
  assert.match(sql, /WHERE/i);
  assert.match(sql, /lower\(subject\)\s*=\s*lower\(\$1\)/i);
  assert.match(sql, /lower\(predicate\)\s*=\s*lower\(\$2\)/i);
  assert.match(sql, /workspace\s*=\s*\$3/i);
  assert.match(sql, /\$4::date/);
  assert.match(sql, /LIMIT \$5/i);
  assert.deepEqual(params, ["Bruno", "role", "personal", "2026-03-15", 10]);
});

test("queryFacts maps rows back to Fact, including metadata", async () => {
  __setPoolForTest({
    query: async () => ({
      rows: [
        {
          subject: "Bruno",
          predicate: "é sócio de",
          object: "Nora",
          workspace: "personal",
          source_id: "page-1",
          source_type: "reuniao",
          confidence: 0.9,
          valid_from: "2026-01-01",
          valid_to: null,
          metadata: { src: "x" },
        },
      ],
    }),
  } as never);
  const out = await queryFacts({ subject: "Bruno" });
  assert.equal(out.length, 1);
  assert.equal(out[0].object, "Nora");
  assert.deepEqual(out[0].metadata, { src: "x" });
});

// --- deleteFactsBySource (S1 replace-on-write) ------------------------------

test("deleteFactsBySource no-ops (returns 0) on empty id, issues no query", async () => {
  let called = false;
  __setPoolForTest({
    query: async () => {
      called = true;
      return { rows: [], rowCount: 0 };
    },
  } as never);
  const n = await deleteFactsBySource("");
  assert.equal(n, 0);
  assert.equal(called, false);
});

test("deleteFactsBySource emits a parameterized DELETE by source_id", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [], rowCount: 3 };
    },
  } as never);
  const n = await deleteFactsBySource("page-42");
  assert.equal(n, 3);
  assert.match(sql, /DELETE FROM brain_facts WHERE source_id = \$1/i);
  assert.deepEqual(params, ["page-42"]);
});
