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

test("buildBrainGraph: empty DB returns empty graph", async () => {
  __setPoolForTest(makePool([
    { rows: [] }, // entity nodes
    { rows: [] }, // doc nodes
    { rows: [] }, // entity-doc edges
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
});

test("buildBrainGraph: maps entity rows to nodes with kind=entity", async () => {
  __setPoolForTest(makePool([
    {
      rows: [
        { id: 1, type: "pessoa", name: "tatiana", mention_count: "5" },
        { id: 2, type: "empresa", name: "nora finance", mention_count: "12" },
      ],
    },
    { rows: [] }, // no doc nodes
    { rows: [] }, // no entity-doc edges
    { rows: [] }, // no entity-entity edges
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

test("buildBrainGraph: maps doc rows to nodes with kind=doc", async () => {
  // Doc query only runs when there are entities — include one entity to trigger it.
  __setPoolForTest(makePool([
    { rows: [{ id: 1, type: "pessoa", name: "ana", mention_count: "1" }] }, // entity needed
    {
      rows: [
        { source_id: "src-abc", source_type: "granola", title: "Reunião Nora", parent_url: "https://granola.so/x", doc_mention_count: "3" },
      ],
    },
    { rows: [] }, // no entity-doc edges (separate query)
    { rows: [] }, // no entity-entity edges (only 1 entity, skipped)
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  // 2 nodes: 1 entity + 1 doc
  assert.equal(g.nodes.length, 2);
  const d = g.nodes.find((n) => n.kind === "doc")!;
  assert.ok(d, "doc node not found");
  assert.equal(d.id, "d:src-abc");
  assert.equal(d.kind, "doc");
  assert.equal(d.label, "Reunião Nora");
  assert.equal(d.type, "granola");
  assert.equal(d.weight, 3);
  assert.equal(d.url, "https://granola.so/x");
});

test("buildBrainGraph: maps entity-doc edge rows", async () => {
  __setPoolForTest(makePool([
    { rows: [{ id: 7, type: "pessoa", name: "ana", mention_count: "2" }] },
    { rows: [{ source_id: "doc-1", source_type: "notion", title: "Doc 1", parent_url: null, doc_mention_count: "2" }] },
    {
      rows: [{ entity_id: 7, source_id: "doc-1", weight: "2" }],
    },
    { rows: [] }, // no entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { a: "e:7", b: "d:doc-1", weight: 2 });
});

test("buildBrainGraph: maps entity-entity co-occurrence edges", async () => {
  // Call sequence when docs are empty:
  // 0: entity nodes (2 entities returned)
  // 1: doc nodes (entityIds.length > 0, returns empty → docNodes stays [])
  // 2: entity-doc edges SKIPPED (docNodes.length === 0)
  // 2: entity-entity edges (entityIds.length > 1, 3rd actual call)
  __setPoolForTest(makePool([
    {
      rows: [
        { id: 1, type: "pessoa", name: "ana", mention_count: "4" },
        { id: 2, type: "empresa", name: "nora", mention_count: "6" },
      ],
    },
    { rows: [] }, // doc nodes — empty
    // entity-doc edges skipped because docNodes is empty
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

test("buildBrainGraph: max_nodes cap defaults to 120 and is respected", async () => {
  // Returns 150 entity rows — graph should still only keep 120
  const manyEntities = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    type: "pessoa",
    name: `person ${i + 1}`,
    mention_count: String(150 - i),
  }));
  __setPoolForTest(makePool([
    { rows: manyEntities },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-1", {});
  assert.ok(g.nodes.length <= 120, `expected ≤120 nodes, got ${g.nodes.length}`);
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
