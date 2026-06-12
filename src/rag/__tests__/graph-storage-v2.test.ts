// src/rag/__tests__/graph-storage-v2.test.ts
// Grafo v2: janela temporal (days), min_edge_weight, last_seen/recent e group_by.
// Fake pool injetado via __setPoolForTest — sem DB real (mesmo padrão de graph-storage.test.ts).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import { buildBrainGraph, computeCommunityGroups } from "../graph-storage.js";

afterEach(() => { __setPoolForTest(null); });

function makeCapturePool(responses: Array<{ rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return responses[i++] ?? { rows: [] };
    },
  };
  return { pool, calls };
}

const twoEntities = {
  rows: [
    { id: 1, type: "pessoa", name: "ana", mention_count: "4" },
    { id: 2, type: "empresa", name: "nora", mention_count: "3" },
  ],
};

// ---- days: filtro temporal no SQL -------------------------------------

test("days: query de nós ganha filtro de data com param certo e HAVING > 0", async () => {
  const { pool, calls } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);

  await buildBrainGraph("acc-1", { days: 30 });

  const nodeQ = calls[0];
  assert.ok(nodeQ.sql.includes("CURRENT_DATE - $3::int"), "filtro de janela ausente na query de nós");
  assert.ok(/HAVING COUNT\(em\.id\) > 0/.test(nodeQ.sql), "com days, entidade sem menção na janela deve sair");
  assert.deepEqual(nodeQ.params, ["acc-1", 40, 30]);
});

test("days: JOIN de co-ocorrência ganha o mesmo filtro de data no bc", async () => {
  const { pool, calls } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);

  await buildBrainGraph("acc-1", { days: 7 });

  const eeQ = calls[1];
  assert.ok(eeQ.sql.includes("CURRENT_DATE - $4::int"), "filtro de janela ausente na query de arestas");
  assert.deepEqual(eeQ.params, ["acc-1", [1, 2], 2, 7]);
});

test("days: cast seguro — usa regex em metadata->>'data' com fallback para source_updated", async () => {
  const { pool, calls } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);

  await buildBrainGraph("acc-1", { days: 30 });

  for (const c of calls.slice(0, 2)) {
    assert.ok(c.sql.includes("~ '^\\d{4}-\\d{2}-\\d{2}'"), "regex guard ausente");
    assert.ok(c.sql.includes("bc.source_updated::date"), "fallback source_updated ausente");
  }
});

test("days: clamp 1..3650 (alto vira 3650, baixo vira 1)", async () => {
  const { pool: p1, calls: c1 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p1 as never);
  await buildBrainGraph("acc-1", { days: 999999 });
  assert.equal(c1[0].params[2], 3650);

  const { pool: p2, calls: c2 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p2 as never);
  await buildBrainGraph("acc-1", { days: 0 });
  assert.equal(c2[0].params[2], 1);
});

test("sem days: nenhuma query ganha filtro de janela e não há HAVING > 0", async () => {
  const { pool, calls } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);

  await buildBrainGraph("acc-1", {});

  assert.ok(!calls[0].sql.includes("CURRENT_DATE"), "query de nós não devia ter janela");
  assert.ok(!/HAVING COUNT\(em\.id\) > 0/.test(calls[0].sql));
  assert.ok(!calls[1].sql.includes("CURRENT_DATE"), "query de arestas não devia ter janela");
});

// ---- min_edge_weight ---------------------------------------------------

test("min_edge_weight: default 2, parametrizado no HAVING", async () => {
  const { pool, calls } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);

  await buildBrainGraph("acc-1", {});

  const eeQ = calls[1];
  assert.ok(eeQ.sql.includes("HAVING COUNT(DISTINCT bc.source_id) >= $3"), "HAVING deve ser parametrizado");
  assert.equal(eeQ.params[2], 2);
});

test("min_edge_weight: clamp 1..50", async () => {
  const { pool: p1, calls: c1 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p1 as never);
  await buildBrainGraph("acc-1", { min_edge_weight: 500 });
  assert.equal(c1[1].params[2], 50);

  const { pool: p2, calls: c2 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p2 as never);
  await buildBrainGraph("acc-1", { min_edge_weight: 0 });
  assert.equal(c2[1].params[2], 1);

  const { pool: p3, calls: c3 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p3 as never);
  await buildBrainGraph("acc-1", { min_edge_weight: 5 });
  assert.equal(c3[1].params[2], 5);
});

// ---- last_seen + recent -------------------------------------------------

test("last_seen: vem da query dedicada (sem days) e entra no shape do nó", async () => {
  const { pool, calls } = makeCapturePool([
    twoEntities,
    { rows: [] }, // ee edges
    { rows: [{ entity_id: 1, last_seen: "2026-06-01" }] }, // last_seen (só p/ id 1)
  ]);
  __setPoolForTest(pool as never);

  const g = await buildBrainGraph("acc-1", {});
  const n1 = g.nodes.find((n) => n.id === "e:1")!;
  const n2 = g.nodes.find((n) => n.id === "e:2")!;
  assert.equal(n1.last_seen, "2026-06-01");
  assert.equal(n2.last_seen, null, "entidade sem data conhecida → null");

  // A query de last_seen nunca leva o filtro de days
  const lsQ = calls[2];
  assert.ok(!lsQ.sql.includes("CURRENT_DATE"), "last_seen deve ignorar a janela");
  assert.deepEqual(lsQ.params, ["acc-1", [1, 2]]);
});

test("last_seen: mesmo com days presente a query de last_seen não filtra por janela", async () => {
  const { pool, calls } = makeCapturePool([
    twoEntities,
    { rows: [] },
    { rows: [{ entity_id: 2, last_seen: "2024-01-15" }] },
  ]);
  __setPoolForTest(pool as never);

  const g = await buildBrainGraph("acc-1", { days: 7 });
  const n2 = g.nodes.find((n) => n.id === "e:2")!;
  assert.equal(n2.last_seen, "2024-01-15");
  assert.ok(!calls[2].sql.includes("CURRENT_DATE"));
});

test("last_seen: nó doc usa a data do próprio doc", async () => {
  const { pool } = makeCapturePool([
    { rows: [{ id: 1, type: "pessoa", name: "ana", mention_count: "2" }] },
    { rows: [{ source_id: "doc-x", source_type: "notion", title: "Doc", parent_url: null, doc_mention_count: "2", last_seen: "2026-05-30" }] },
    { rows: [{ entity_id: 1, source_id: "doc-x", weight: "2" }] },
    { rows: [{ entity_id: 1, last_seen: "2026-05-30" }] },
  ]);
  __setPoolForTest(pool as never);

  const g = await buildBrainGraph("acc-1", { mode: "focus", entity_ids: [1], include_docs: true });
  const doc = g.nodes.find((n) => n.kind === "doc")!;
  assert.equal(doc.last_seen, "2026-05-30");
});

test("recent: igual a weight (com e sem days)", async () => {
  const { pool } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);
  const g1 = await buildBrainGraph("acc-1", {});
  for (const n of g1.nodes) assert.equal(n.recent, n.weight);

  const { pool: p2 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p2 as never);
  const g2 = await buildBrainGraph("acc-1", { days: 30 });
  for (const n of g2.nodes) assert.equal(n.recent, n.weight);
});

// ---- computeCommunityGroups (union-find puro) ---------------------------

test("computeCommunityGroups: dois componentes + nó isolado = null", () => {
  const groups = computeCommunityGroups(
    ["e:1", "e:2", "e:3", "e:4", "e:5"],
    [{ a: "e:1", b: "e:2" }, { a: "e:3", b: "e:4" }],
  );
  assert.equal(groups.get("e:1"), groups.get("e:2"));
  assert.equal(groups.get("e:3"), groups.get("e:4"));
  assert.notEqual(groups.get("e:1"), groups.get("e:3"));
  assert.equal(groups.get("e:5"), null);
});

test("computeCommunityGroups: empate de tamanho é determinístico (menor id primeiro)", () => {
  // Mesmos componentes, ordens de entrada diferentes → mesmo resultado.
  const a = computeCommunityGroups(
    ["e:1", "e:2", "e:3", "e:4"],
    [{ a: "e:1", b: "e:2" }, { a: "e:3", b: "e:4" }],
  );
  const b = computeCommunityGroups(
    ["e:4", "e:3", "e:2", "e:1"],
    [{ a: "e:3", b: "e:4" }, { a: "e:1", b: "e:2" }],
  );
  // Empate 2x2: componente com menor membro ("e:1") leva group 0 nos dois casos.
  assert.equal(a.get("e:1"), 0);
  assert.equal(a.get("e:3"), 1);
  assert.equal(b.get("e:1"), 0);
  assert.equal(b.get("e:3"), 1);
});

test("computeCommunityGroups: componentes ordenados por tamanho desc", () => {
  const groups = computeCommunityGroups(
    ["e:8", "e:9", "e:1", "e:2", "e:3"],
    [{ a: "e:8", b: "e:9" }, { a: "e:1", b: "e:2" }, { a: "e:2", b: "e:3" }],
  );
  // {e:1,e:2,e:3} (3) → 0; {e:8,e:9} (2) → 1
  assert.equal(groups.get("e:1"), 0);
  assert.equal(groups.get("e:2"), 0);
  assert.equal(groups.get("e:3"), 0);
  assert.equal(groups.get("e:8"), 1);
  assert.equal(groups.get("e:9"), 1);
});

test("computeCommunityGroups: aresta com endpoint desconhecido é ignorada", () => {
  const groups = computeCommunityGroups(
    ["e:1", "e:2"],
    [{ a: "e:1", b: "e:99" }],
  );
  assert.equal(groups.get("e:1"), null);
  assert.equal(groups.get("e:2"), null);
});

// ---- group_by no buildBrainGraph ----------------------------------------

test("group_by=type: group = type do nó", async () => {
  const { pool } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);

  const g = await buildBrainGraph("acc-1", { group_by: "type" });
  const n1 = g.nodes.find((n) => n.id === "e:1")!;
  const n2 = g.nodes.find((n) => n.id === "e:2")!;
  assert.equal(n1.group, "pessoa");
  assert.equal(n2.group, "empresa");
});

test("group_by=community: componentes conectados das arestas computadas; isolado = null", async () => {
  const { pool } = makeCapturePool([
    {
      rows: [
        { id: 1, type: "pessoa", name: "ana", mention_count: "4" },
        { id: 2, type: "empresa", name: "nora", mention_count: "3" },
        { id: 3, type: "projeto", name: "zinom", mention_count: "1" },
      ],
    },
    { rows: [{ entity_a: 1, entity_b: 2, weight: "3" }] },
    { rows: [] },
  ]);
  __setPoolForTest(pool as never);

  const g = await buildBrainGraph("acc-1", { group_by: "community" });
  assert.equal(g.nodes.find((n) => n.id === "e:1")!.group, 0);
  assert.equal(g.nodes.find((n) => n.id === "e:2")!.group, 0);
  assert.equal(g.nodes.find((n) => n.id === "e:3")!.group, null);
});

test("group_by ausente/none: nó não ganha campo group (shape antigo preservado)", async () => {
  const { pool } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(pool as never);
  const g1 = await buildBrainGraph("acc-1", {});
  for (const n of g1.nodes) assert.ok(!("group" in n), "sem group_by não deve haver campo group");

  const { pool: p2 } = makeCapturePool([twoEntities, { rows: [] }, { rows: [] }]);
  __setPoolForTest(p2 as never);
  const g2 = await buildBrainGraph("acc-1", { group_by: "none" });
  for (const n of g2.nodes) assert.ok(!("group" in n));
});

// ---- isolamento multi-tenant ---------------------------------------------

test("isolamento: toda query (inclusive as novas) leva account_id como $1", async () => {
  const { pool, calls } = makeCapturePool([
    { rows: [{ id: 1, type: "pessoa", name: "ana", mention_count: "2" }] },
    { rows: [{ source_id: "doc-x", source_type: "notion", title: "Doc", parent_url: null, doc_mention_count: "2", last_seen: "2026-05-30" }] },
    { rows: [{ entity_id: 1, source_id: "doc-x", weight: "2" }] },
    { rows: [{ entity_id: 1, last_seen: "2026-05-30" }] },
  ]);
  __setPoolForTest(pool as never);

  await buildBrainGraph("friend:abc", {
    mode: "focus", entity_ids: [1], include_docs: true, days: 30, min_edge_weight: 3,
  });

  assert.ok(calls.length >= 4, "fluxo focus+docs+last_seen deve ter ≥4 queries");
  for (const c of calls) {
    assert.equal(c.params[0], "friend:abc", `accountId deve ser $1 em: ${c.sql.slice(0, 60)}`);
    assert.ok(c.sql.includes("account_id = $1"), `account_id = $1 ausente em: ${c.sql.slice(0, 60)}`);
  }
});
