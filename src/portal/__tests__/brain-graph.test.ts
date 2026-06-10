// src/portal/__tests__/brain-graph.test.ts
// Unit tests for GET /portal/brain/graph.
// Tests the storage layer directly (same pattern as entities.test.ts).
// v2: overview mode (default) has NO doc nodes, only entity-entity edges.
//     focus mode + include_docs=true returns entity nodes + doc nodes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../../rag/storage.js";
import { buildBrainGraph } from "../../rag/graph-storage.js";

afterEach(() => { __setPoolForTest(null); });

function makePool(responses: Array<{ rows: unknown[] }>) {
  let call = 0;
  return {
    query: async () => responses[call++] ?? { rows: [] },
  };
}

test("buildBrainGraph: account isolation — accountId is always the first param", async () => {
  const captured: unknown[][] = [];
  __setPoolForTest({
    query: async (_sql: string, params: unknown[]) => {
      captured.push(params);
      return { rows: [] };
    },
  } as never);

  await buildBrainGraph("friend:xyz", {});
  // Every query must have accountId as first param
  for (const p of captured) {
    assert.equal(p[0], "friend:xyz", `param[0] should be accountId, got: ${p[0]}`);
  }
});

test("buildBrainGraph: response shape has nodes and edges arrays", async () => {
  // overview mode: 2 calls (entity nodes + entity-entity edges)
  __setPoolForTest(makePool([{ rows: [] }, { rows: [] }]) as never);
  const result = await buildBrainGraph("acc-a", {});
  assert.ok(Array.isArray(result.nodes), "nodes must be array");
  assert.ok(Array.isArray(result.edges), "edges must be array");
});

test("buildBrainGraph: max_nodes cap works (150 hard cap in v2)", async () => {
  // v2 caps at 150 (not 300); overview default is 40, but explicit max_nodes is honoured up to 150
  const manyEntities = Array.from({ length: 200 }, (_, i) => ({
    id: i + 1, type: "pessoa", name: `p${i}`, mention_count: "1",
  }));
  __setPoolForTest(makePool([
    { rows: manyEntities },
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-a", { max_nodes: 500 });
  assert.ok(g.nodes.length <= 150, `cap violated: ${g.nodes.length}`);
});

test("buildBrainGraph: node ids are namespaced (e: prefix for entities)", async () => {
  // overview mode: 2 calls (no doc query)
  __setPoolForTest(makePool([
    { rows: [{ id: 10, type: "empresa", name: "Nora", mention_count: "3" }] },
    { rows: [] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-a", {});
  assert.ok(g.nodes.some((n) => n.id === "e:10"), "entity node id should be e:10");
  // Overview has no doc nodes
  assert.ok(g.nodes.every((n) => n.kind === "entity"), "overview should only have entity nodes");
});

test("buildBrainGraph (focus+include_docs): node ids are namespaced (e: and d: prefixes)", async () => {
  // focus + include_docs=true: 4 calls
  __setPoolForTest(makePool([
    { rows: [{ id: 10, type: "empresa", name: "Nora", mention_count: "3" }] },
    { rows: [{ source_id: "s1", source_type: "notion", title: "Doc", parent_url: null, doc_mention_count: "1" }] },
    { rows: [{ entity_id: 10, source_id: "s1", weight: "1" }] },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-a", { mode: "focus", entity_ids: [10], include_docs: true });
  assert.ok(g.nodes.some((n) => n.id === "e:10"), "entity node id should be e:10");
  assert.ok(g.nodes.some((n) => n.id === "d:s1"), "doc node id should be d:s1");
});

test("buildBrainGraph (focus+include_docs): edge references existing node ids", async () => {
  // focus + include_docs=true: 4 calls
  __setPoolForTest(makePool([
    { rows: [{ id: 5, type: "pessoa", name: "Ana", mention_count: "2" }] },
    { rows: [{ source_id: "doc-x", source_type: "granola", title: "Reunião", parent_url: null, doc_mention_count: "2" }] },
    { rows: [{ entity_id: 5, source_id: "doc-x", weight: "2" }] },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-a", { mode: "focus", entity_ids: [5], include_docs: true });
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    assert.ok(nodeIds.has(e.a), `edge.a="${e.a}" not in nodes`);
    assert.ok(nodeIds.has(e.b), `edge.b="${e.b}" not in nodes`);
  }
});

test("buildBrainGraph: returns non-empty graph when entities exist (overview)", async () => {
  // In overview mode, docs are not returned — only entities + entity-entity edges
  __setPoolForTest(makePool([
    {
      rows: [
        { id: 1, type: "pessoa", name: "Tatiana", mention_count: "10" },
        { id: 2, type: "empresa", name: "Nora Finance", mention_count: "7" },
      ],
    },
    { rows: [{ entity_a: 1, entity_b: 2, weight: "3" }] }, // entity-entity edges
  ]) as never);

  const g = await buildBrainGraph("acc-real", {});
  assert.ok(g.nodes.length > 0, "must have nodes when entities exist");
  assert.ok(g.edges.length > 0, "must have edges when entity-entity co-occurrence exists");
  assert.ok(g.nodes.every((n) => n.kind === "entity"), "overview must have only entity nodes");
  assert.equal(g.mode, "overview");
});
