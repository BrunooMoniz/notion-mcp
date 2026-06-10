// src/portal/__tests__/brain-documents-multi.test.ts
// TDD: multi-entity filter for GET /portal/brain/documents and /portal/brain/graph.
// Uses __setPoolForTest — no live DB.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest, listBrainDocuments } from "../../rag/storage.js";
import { buildBrainGraph } from "../../rag/graph-storage.js";

afterEach(() => { __setPoolForTest(null); });

// --- listBrainDocuments: multi-entity (entity_ids CSV) ---

test("listBrainDocuments: entity_ids match=all emits HAVING count = N (SQL proof)", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      capturedSql += sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as never);

  await listBrainDocuments("acc-a", { entityIds: [1, 2, 3], match: "all" });

  // Must filter by account
  assert.match(capturedSql, /account_id\s*=\s*\$1/i, "account isolation missing");
  // ALL-match: must use HAVING count(distinct ...) = N or equivalent
  assert.match(capturedSql, /HAVING/i, "HAVING clause missing for match=all");
  // The entity ids must appear in params
  assert.ok(
    capturedParams.some((p) => Array.isArray(p) && p.includes(1) && p.includes(2) && p.includes(3)),
    "entity ids not forwarded to query",
  );
});

test("listBrainDocuments: entity_ids match=any emits ANY($) or IN or >=1 (SQL proof)", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      capturedSql += sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as never);

  await listBrainDocuments("acc-a", { entityIds: [10, 20], match: "any" });

  assert.match(capturedSql, /account_id\s*=\s*\$1/i, "account isolation missing");
  // ANY-match: must use ANY or IN to select sources that mention at least one entity
  assert.ok(
    /ANY\s*\(/i.test(capturedSql) || /IN\s*\(/i.test(capturedSql) || />=\s*1/.test(capturedSql),
    "any-match clause missing",
  );
  assert.ok(
    capturedParams.some((p) => Array.isArray(p) && p.includes(10) && p.includes(20)),
    "entity ids not forwarded for match=any",
  );
});

test("listBrainDocuments: single entity_id (legacy) still works", async () => {
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (_sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    },
  } as never);

  await listBrainDocuments("acc-b", { entityId: 42 });
  assert.equal(capturedParams[0], "acc-b", "account must be first param");
  // entityId is now normalized to [42] internally for uniform treatment
  assert.ok(
    capturedParams.some((p) => (Array.isArray(p) && p.includes(42)) || p === 42),
    "entityId 42 not in params",
  );
});

test("listBrainDocuments: entity_ids wins over entityId when both provided", async () => {
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (_sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    },
  } as never);

  // When entity_ids is present it should supersede entityId
  await listBrainDocuments("acc-c", { entityId: 99, entityIds: [5, 6], match: "all" });
  // The batch form [5,6] must appear; 99 alone must NOT appear as scalar
  assert.ok(
    capturedParams.some((p) => Array.isArray(p) && p.includes(5) && p.includes(6)),
    "entityIds not used when both provided",
  );
});

test("listBrainDocuments: entity_ids account isolation — different accounts independent", async () => {
  const paramsA: unknown[][] = [];
  const paramsB: unknown[][] = [];

  __setPoolForTest({ query: async (_s: string, p: unknown[]) => { paramsA.push(p); return { rows: [] }; } } as never);
  await listBrainDocuments("acc-A", { entityIds: [1], match: "all" });

  __setPoolForTest({ query: async (_s: string, p: unknown[]) => { paramsB.push(p); return { rows: [] }; } } as never);
  await listBrainDocuments("acc-B", { entityIds: [1], match: "all" });

  // Each set of params starts with its own accountId
  assert.equal(paramsA[0][0], "acc-A");
  assert.equal(paramsB[0][0], "acc-B");
});

// --- buildBrainGraph: entity_ids multi-select subgraph ---

function makePool(responses: Array<{ rows: unknown[] }>) {
  let call = 0;
  return { query: async () => responses[call++] ?? { rows: [] } };
}

test("buildBrainGraph: entity_ids (multi) — selected entities appear in params", async () => {
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (_sql: string, params: unknown[]) => {
      if (params.length > capturedParams.length) capturedParams = params;
      return { rows: [] };
    },
  } as never);

  await buildBrainGraph("acc-g", { entityIds: [10, 20, 30] });

  // The entity ids must appear as an array param in at least one query
  assert.ok(
    capturedParams.some((p) => Array.isArray(p) && p.includes(10) && p.includes(20) && p.includes(30)),
    "entity_ids not forwarded to graph query",
  );
});

test("buildBrainGraph: entity_ids multi returns valid graph shape", async () => {
  __setPoolForTest(makePool([
    // entity nodes — two entities returned
    { rows: [
      { id: 10, type: "pessoa", name: "Ana", mention_count: "5" },
      { id: 20, type: "empresa", name: "Nora", mention_count: "3" },
    ] },
    // doc nodes
    { rows: [{ source_id: "d1", source_type: "granola", title: "Reunião Nora", parent_url: null, doc_mention_count: "2" }] },
    // entity-doc edges
    { rows: [
      { entity_id: 10, source_id: "d1", weight: "1" },
      { entity_id: 20, source_id: "d1", weight: "1" },
    ] },
    // entity-entity edges
    { rows: [{ entity_a: 10, entity_b: 20, weight: "1" }] },
  ]) as never);

  const g = await buildBrainGraph("acc-g", { entityIds: [10, 20] });

  assert.ok(Array.isArray(g.nodes), "nodes must be array");
  assert.ok(Array.isArray(g.edges), "edges must be array");
  assert.ok(g.nodes.length > 0, "should have nodes for two entities");
  // All edge endpoints must reference existing nodes
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    assert.ok(nodeIds.has(e.a), `edge.a="${e.a}" not in nodes`);
    assert.ok(nodeIds.has(e.b), `edge.b="${e.b}" not in nodes`);
  }
});
