// src/rag/__tests__/entity-management.test.ts
// TDD tests for entity management: mergeEntities + renameEntity.
// No live DB: stub pool injected via __setPoolForTest.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import { mergeEntities, renameEntity } from "../entity-management.js";

afterEach(() => { __setPoolForTest(null); });

// Helper: sequential mock pool
function makePool(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  let call = 0;
  return {
    query: async () => { const r = responses[call++] ?? { rows: [], rowCount: 0 }; return r; },
  };
}

// Helper: transaction-aware mock pool
function makeTxPool(queryMap: Record<string, { rows: unknown[]; rowCount?: number }>) {
  let defaultRows: { rows: unknown[]; rowCount: number } = { rows: [], rowCount: 0 };
  return {
    query: async (sql: string, _params?: unknown[]) => {
      const key = Object.keys(queryMap).find(k => sql.includes(k));
      return key ? queryMap[key] : defaultRows;
    },
  };
}

// ---- mergeEntities ----

test("mergeEntities: returns 404 when keep entity not found in account", async () => {
  __setPoolForTest(makePool([
    { rows: [] }, // keep entity ownership check → not found
  ]) as never);

  const result = await mergeEntities("acc-1", 10, 20);
  assert.equal(result.error, "keep_not_found");
});

test("mergeEntities: returns 404 when merge entity not found in account", async () => {
  __setPoolForTest(makePool([
    { rows: [{ id: 10, name: "ana", type: "pessoa", aliases: [] }] }, // keep found
    { rows: [] }, // merge entity → not found
  ]) as never);

  const result = await mergeEntities("acc-1", 10, 20);
  assert.equal(result.error, "merge_not_found");
});

test("mergeEntities: reassigns mentions from merge_id to keep_id (no duplicate chunk_id)", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callCount = 0;
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      callCount++;
      // First call: ownership check for keep_id (params: [keepId, accountId])
      if (callCount === 1 && sql.includes("SELECT id, name"))
        return { rows: [{ id: 10, name: "ana", type: "pessoa", aliases: ["anna"] }] };
      // Second call: ownership check for merge_id
      if (callCount === 2 && sql.includes("SELECT id, name"))
        return { rows: [{ id: 20, name: "bruno bernar", type: "pessoa", aliases: [] }] };
      return { rows: [], rowCount: 0 };
    },
  } as never);

  const result = await mergeEntities("acc-1", 10, 20);
  assert.equal((result as { ok: boolean }).ok, true);

  // Should have issued: 2 ownership checks, then mention reassignment, alias update, delete
  assert.ok(queries.some(q => q.sql.includes("UPDATE entity_mentions")),
    "must UPDATE entity_mentions to reassign from merge_id to keep_id");
});

test("mergeEntities: adds merge entity name to keep entity aliases", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callCount = 0;
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      callCount++;
      if (callCount === 1 && sql.includes("SELECT id, name"))
        return { rows: [{ id: 10, name: "ana", type: "pessoa", aliases: [] }] };
      if (callCount === 2 && sql.includes("SELECT id, name"))
        return { rows: [{ id: 20, name: "bruno bernar", type: "pessoa", aliases: [] }] };
      return { rows: [], rowCount: 0 };
    },
  } as never);

  await mergeEntities("acc-1", 10, 20);

  // aliases UPDATE must reference the merge entity's name
  const aliasUpdate = queries.find(q => q.sql.includes("aliases") && q.sql.includes("UPDATE entities"));
  assert.ok(aliasUpdate, "must UPDATE aliases on keep entity");
  assert.ok(aliasUpdate!.params.some(p => p === "bruno bernar" || (Array.isArray(p) && p.includes("bruno bernar"))),
    "merge entity name must appear in alias update params");
});

test("mergeEntities: deletes merge entity after reassignment", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callCount = 0;
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      callCount++;
      if (callCount === 1 && sql.includes("SELECT id, name"))
        return { rows: [{ id: 10, name: "ana", type: "pessoa", aliases: [] }] };
      if (callCount === 2 && sql.includes("SELECT id, name"))
        return { rows: [{ id: 20, name: "bruno bernar", type: "pessoa", aliases: [] }] };
      return { rows: [], rowCount: 0 };
    },
  } as never);

  await mergeEntities("acc-1", 10, 20);

  const del = queries.find(q => q.sql.includes("DELETE FROM entities") && q.params.includes(20));
  assert.ok(del, "must DELETE merge entity (id=20)");
});

test("mergeEntities: cross-account 404 on keep entity", async () => {
  __setPoolForTest(makePool([
    { rows: [] }, // keep entity not found (different account)
  ]) as never);

  const result = await mergeEntities("acc-other", 10, 20);
  assert.equal(result.error, "keep_not_found");
});

// ---- renameEntity ----

test("renameEntity: returns 404 when entity not found in account", async () => {
  __setPoolForTest(makePool([
    { rows: [] }, // entity not found
  ]) as never);

  const result = await renameEntity("acc-1", 10, { name: "new name" });
  assert.equal(result.error, "not_found");
});

test("renameEntity: preserves old name in aliases when renaming", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT id, name, type, aliases"))
        return { rows: [{ id: 10, name: "bruno bernar", type: "pessoa", aliases: [] }] };
      return { rows: [{ id: 10 }], rowCount: 1 };
    },
  } as never);

  const result = await renameEntity("acc-1", 10, { name: "bruno moniz" });
  assert.equal(result.ok, true);

  // aliases UPDATE must include the old name
  const update = queries.find(q => q.sql.includes("UPDATE entities") && q.sql.includes("aliases"));
  assert.ok(update, "must UPDATE entity with new name and aliases");
  assert.ok(update!.params.some(p => p === "bruno bernar" || (Array.isArray(p) && p.includes("bruno bernar"))),
    "old name must be preserved in aliases");
});

test("renameEntity: can update type without renaming", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT id, name, type, aliases"))
        return { rows: [{ id: 5, name: "Nora Finance", type: "pessoa", aliases: [] }] };
      return { rows: [{ id: 5 }], rowCount: 1 };
    },
  } as never);

  const result = await renameEntity("acc-1", 5, { type: "empresa" });
  assert.equal(result.ok, true);

  // Must UPDATE the type
  const update = queries.find(q => q.sql.includes("UPDATE entities") && q.params.includes("empresa"));
  assert.ok(update, "must UPDATE entity type");
});

test("renameEntity: cross-account 404", async () => {
  __setPoolForTest(makePool([
    { rows: [] }, // entity not found for different account
  ]) as never);

  const result = await renameEntity("acc-evil", 99, { name: "hack" });
  assert.equal(result.error, "not_found");
});
