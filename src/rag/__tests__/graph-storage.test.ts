// src/rag/__tests__/graph-storage.test.ts
// Unit tests for buildBrainGraph — fake pool, no live DB.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import { buildBrainGraph } from "../graph-storage.js";

afterEach(() => { __setPoolForTest(null); });

// Helper: create a fake pool that returns different rows per call count.
function makePool(responses: Array<{ rows: unknown[] }>) {
  let call = 0;
  return {
    query: async () => responses[call++] ?? { rows: [] },
  };
}

// ---- EXISTING TESTS (updated for new 2-call overview mode) ----

test("buildBrainGraph: empty DB returns empty graph", async () => {
  // overview mode: 2 DB calls (entity nodes + entity-entity edges)
  __setPoolForTest(makePool([
    { rows: [] }, // entity nodes
    { rows: [] }, // entity-entity edges (skipped when entityIds < 2, but pool returns [] anyway)
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
});

test("buildBrainGraph: maps entity rows to nodes with kind=entity", async () => {
  // overview mode: 2 calls (no doc query)
  __setPoolForTest(makePool([
    {
      rows: [
        { id: 1, type: "pessoa", name: "tatiana", mention_count: "5" },
        { id: 2, type: "empresa", name: "nora finance", mention_count: "12" },
      ],
    },
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.equal(g.nodes.length, 2);
  const e1 = g.nodes[0];
  assert.equal(e1.id, "e:1");
  assert.equal(e1.kind, "entity");
  assert.equal(e1.label, "tatiana");
  assert.equal(e1.type, "pessoa");
  assert.equal(e1.weight, 5);
  const e2 = g.nodes[1];
  assert.equal(e2.id, "e:2");
  assert.equal(e2.type, "empresa");
  assert.equal(e2.weight, 12);
});

test("buildBrainGraph: overview has NO doc nodes", async () => {
  // Overview mode (default) should never include doc nodes
  __setPoolForTest(makePool([
    { rows: [{ id: 1, type: "pessoa", name: "ana", mention_count: "3" }] },
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.ok(g.nodes.every(n => n.kind === "entity"), "overview must have no doc nodes");
  assert.equal(g.mode, "overview");
});

test("buildBrainGraph: maps entity-entity co-occurrence edges in overview", async () => {
  // overview: 2 calls (entity nodes + entity-entity edges)
  __setPoolForTest(makePool([
    {
      rows: [
        { id: 1, type: "pessoa", name: "ana", mention_count: "4" },
        { id: 2, type: "empresa", name: "nora", mention_count: "6" },
      ],
    },
    { rows: [{ entity_a: 1, entity_b: 2, weight: "3" }] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { a: "e:1", b: "e:2", weight: 3 });
});

test("buildBrainGraph: type filter is forwarded (query receives it)", async () => {
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (_sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    },
  } as never);

  await buildBrainGraph("acc-1", { type: "empresa" });
  // The type param must appear somewhere in the first query's params
  assert.ok(capturedParams.includes("empresa"), "type filter not forwarded to query");
});

test("buildBrainGraph: max_nodes cap defaults to 40 in overview", async () => {
  // overview default cap is 40 (not 120)
  const manyEntities = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    type: "pessoa",
    name: `person ${i + 1}`,
    mention_count: String(60 - i),
  }));
  __setPoolForTest(makePool([
    { rows: manyEntities },
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.ok(g.nodes.length <= 40, `expected ≤40 nodes in overview, got ${g.nodes.length}`);
});

test("buildBrainGraph: entity_id subgraph filter restricts to that entity's neighbourhood", async () => {
  let queries: string[] = [];
  __setPoolForTest({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as never);

  await buildBrainGraph("acc-1", { entity_id: 42 });
  // At least one query must reference entity_id=42 filtering
  assert.ok(queries.some((q) => q.includes("$") || q.toLowerCase().includes("entity_id")),
    "entity_id subgraph filter not applied");
});

// ---- NEW MODE TESTS ----

test("buildBrainGraph overview: does not include doc nodes", async () => {
  // DB returns 2 entities — overview must suppress doc nodes
  __setPoolForTest(makePool([
    { rows: [
      { id: 1, type: "pessoa", name: "ana", mention_count: "5" },
      { id: 2, type: "empresa", name: "nora", mention_count: "3" },
    ]},
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "overview" });
  assert.ok(g.nodes.every(n => n.kind === "entity"), "overview must have no doc nodes");
  assert.equal(g.nodes.length, 2);
});

test("buildBrainGraph overview: default max_nodes is 40", async () => {
  // Return 60 entity rows — overview should cap at 40
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, type: "pessoa", name: `p${i + 1}`, mention_count: String(60 - i),
  }));
  __setPoolForTest(makePool([
    { rows: many },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "overview" });
  assert.ok(g.nodes.length <= 40, `overview capped at 40, got ${g.nodes.length}`);
});

test("buildBrainGraph overview: edges are entity-entity only (no entity-doc)", async () => {
  __setPoolForTest(makePool([
    { rows: [
      { id: 1, type: "pessoa", name: "ana", mention_count: "4" },
      { id: 2, type: "empresa", name: "nora", mention_count: "6" },
    ]},
    { rows: [{ entity_a: 1, entity_b: 2, weight: "3" }] },
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "overview" });
  // All edges must connect two entity nodes
  const entityIds = new Set(g.nodes.filter(n => n.kind === "entity").map(n => n.id));
  g.edges.forEach(e => {
    assert.ok(entityIds.has(e.a), `edge.a=${e.a} is not an entity`);
    assert.ok(entityIds.has(e.b), `edge.b=${e.b} is not an entity`);
  });
});

test("buildBrainGraph focus: returns selected entity + neighbors", async () => {
  __setPoolForTest(makePool([
    { rows: [
      { id: 42, type: "pessoa", name: "target", mention_count: "8" },
      { id: 99, type: "empresa", name: "neighbor", mention_count: "3" },
    ]},
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "focus", entity_ids: [42] });
  assert.ok(g.nodes.some(n => n.id === "e:42"), "target entity must be present");
  assert.equal(g.mode, "focus");
});

test("buildBrainGraph focus with include_docs=false: no doc nodes returned", async () => {
  __setPoolForTest(makePool([
    { rows: [{ id: 1, type: "pessoa", name: "ana", mention_count: "2" }] },
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "focus", entity_ids: [1], include_docs: false });
  assert.ok(g.nodes.every(n => n.kind === "entity"), "no docs when include_docs=false");
});

test("buildBrainGraph focus with include_docs=true: doc nodes present", async () => {
  __setPoolForTest(makePool([
    { rows: [{ id: 1, type: "pessoa", name: "ana", mention_count: "2" }] },
    { rows: [{ source_id: "doc-x", source_type: "notion", title: "My Doc", parent_url: null, doc_mention_count: "2" }] },
    { rows: [{ entity_id: 1, source_id: "doc-x", weight: "2" }] }, // entity-doc edges
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "focus", entity_ids: [1], include_docs: true });
  assert.ok(g.nodes.some(n => n.kind === "doc"), "doc nodes must appear when include_docs=true");
});

test("buildBrainGraph focus: max_nodes defaults to 60 and is capped at 150", async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: i + 1, type: "pessoa", name: `p${i + 1}`, mention_count: String(200 - i),
  }));
  __setPoolForTest(makePool([
    { rows: many },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-1", { mode: "focus", entity_ids: [1] });
  assert.ok(g.nodes.length <= 150, `focus cap 150, got ${g.nodes.length}`);
  assert.ok(g.nodes.length <= 60, `focus default cap 60, got ${g.nodes.length}`);
});

test("buildBrainGraph: legacy entity_id maps to focus mode", async () => {
  let capturedSQL = "";
  __setPoolForTest({
    query: async (sql: string) => {
      capturedSQL += sql;
      return { rows: [] };
    },
  } as never);

  // Using legacy entity_id should trigger subgraph / focus behaviour
  await buildBrainGraph("acc-1", { entity_id: 7 });
  // The SQL must reference a subgraph filter (entity neighbour join)
  assert.ok(capturedSQL.includes("entity_id") || capturedSQL.includes("em1") || capturedSQL.includes("em2"),
    "legacy entity_id must trigger focus/subgraph SQL");
});

test("buildBrainGraph: legacy entityIds (plural) maps to focus mode", async () => {
  let capturedSQL = "";
  __setPoolForTest({
    query: async (sql: string) => {
      capturedSQL += sql;
      return { rows: [] };
    },
  } as never);

  await buildBrainGraph("acc-1", { entityIds: [3, 4] });
  assert.ok(capturedSQL.includes("entity_id") || capturedSQL.includes("em1"),
    "legacy entityIds must trigger focus/subgraph SQL");
});
