// src/portal/__tests__/brain-graph.test.ts
// Unit tests for GET /portal/brain/graph.
// Tests the storage layer directly (same pattern as entities.test.ts).
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
  __setPoolForTest(makePool([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]) as never);
  const result = await buildBrainGraph("acc-a", {});
  assert.ok(Array.isArray(result.nodes), "nodes must be array");
  assert.ok(Array.isArray(result.edges), "edges must be array");
});

test("buildBrainGraph: max_nodes cap works (300 hard cap)", async () => {
  // Ask for 500 but the cap should be 300
  const manyEntities = Array.from({ length: 400 }, (_, i) => ({
    id: i + 1, type: "pessoa", name: `p${i}`, mention_count: "1",
  }));
  __setPoolForTest(makePool([
    { rows: manyEntities },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-a", { max_nodes: 500 });
  assert.ok(g.nodes.length <= 300, `cap violated: ${g.nodes.length}`);
});

test("buildBrainGraph: node ids are namespaced (e: and d: prefixes)", async () => {
  __setPoolForTest(makePool([
    { rows: [{ id: 10, type: "empresa", name: "Nora", mention_count: "3" }] },
    { rows: [{ source_id: "s1", source_type: "notion", title: "Doc", parent_url: null, doc_mention_count: "1" }] },
    { rows: [{ entity_id: 10, source_id: "s1", weight: "1" }] },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-a", {});
  assert.ok(g.nodes.some((n) => n.id === "e:10"), "entity node id should be e:10");
  assert.ok(g.nodes.some((n) => n.id === "d:s1"), "doc node id should be d:s1");
});

test("buildBrainGraph: edge references existing node ids", async () => {
  __setPoolForTest(makePool([
    { rows: [{ id: 5, type: "pessoa", name: "Ana", mention_count: "2" }] },
    { rows: [{ source_id: "doc-x", source_type: "granola", title: "Reunião", parent_url: null, doc_mention_count: "2" }] },
    { rows: [{ entity_id: 5, source_id: "doc-x", weight: "2" }] },
    { rows: [] },
  ]) as never);

  const g = await buildBrainGraph("acc-a", {});
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    assert.ok(nodeIds.has(e.a), `edge.a="${e.a}" not in nodes`);
    assert.ok(nodeIds.has(e.b), `edge.b="${e.b}" not in nodes`);
  }
});
