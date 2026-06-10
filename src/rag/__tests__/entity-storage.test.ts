// src/rag/__tests__/entity-storage.test.ts
// Unit tests for entity-storage. NO live DB: stub pool injected via __setPoolForTest.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../storage.js";
import {
  normalizeEntityName,
  upsertEntity,
  upsertEntityMention,
  findSimilarEntity,
  listEntities,
  listEntityDocuments,
} from "../entity-storage.js";

afterEach(() => {
  __setPoolForTest(null);
});

// --- normalizeEntityName ---

test("normalizeEntityName lowercases and strips accents", () => {
  assert.equal(normalizeEntityName("Tatiana Guazzelli"), "tatiana guazzelli");
});

test("normalizeEntityName strips accented chars", () => {
  assert.equal(normalizeEntityName("João"), "joao");
});

test("normalizeEntityName collapses multiple spaces", () => {
  assert.equal(normalizeEntityName("  Nora   Finance  "), "nora finance");
});

test("normalizeEntityName removes special chars except spaces", () => {
  assert.equal(normalizeEntityName("B2C2 Corp."), "b2c2 corp");
});

// --- upsertEntity ---

test("upsertEntity issues INSERT ON CONFLICT with correct params", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ id: 42 }], rowCount: 1 };
    },
  } as never);

  const id = await upsertEntity("acc1", "pessoa", "tatiana guazzelli", []);
  assert.equal(id, 42);
  assert.match(capturedSql, /INSERT INTO entities/i);
  assert.match(capturedSql, /ON CONFLICT/i);
  assert.equal(capturedParams[0], "acc1");
  assert.equal(capturedParams[1], "pessoa");
  assert.equal(capturedParams[2], "tatiana guazzelli");
});

// --- upsertEntityMention ---

test("upsertEntityMention issues INSERT ON CONFLICT for entity_mentions", async () => {
  let capturedSql = "";
  __setPoolForTest({
    query: async (sql: string) => {
      capturedSql = sql;
      return { rows: [], rowCount: 1 };
    },
  } as never);

  await upsertEntityMention(42, "chunk-abc", 1.0);
  assert.match(capturedSql, /INSERT INTO entity_mentions/i);
  assert.match(capturedSql, /ON CONFLICT/i);
});

// --- findSimilarEntity ---

test("findSimilarEntity returns null when pool returns no rows", async () => {
  __setPoolForTest({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as never);

  const result = await findSimilarEntity("acc1", "pessoa", "tatiana");
  assert.equal(result, null);
});

test("findSimilarEntity returns entity when similarity >= 0.7", async () => {
  __setPoolForTest({
    query: async () => ({
      rows: [{ id: 5, name: "tatiana guazzelli", aliases: ["tatiana"], similarity: 0.8 }],
      rowCount: 1,
    }),
  } as never);

  const result = await findSimilarEntity("acc1", "pessoa", "tatiana");
  assert.ok(result !== null);
  assert.equal(result!.id, 5);
});

// --- listEntities ---

test("listEntities issues correct SQL with account_id filter", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  __setPoolForTest({
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [], rowCount: 0 };
    },
  } as never);

  await listEntities("acc1", {});
  assert.match(capturedSql, /FROM entities/i);
  assert.ok(capturedParams.includes("acc1"), "account_id must be a query param");
});

test("listEntities adds type filter when provided", async () => {
  let capturedSql = "";
  __setPoolForTest({
    query: async (sql: string) => {
      capturedSql = sql;
      return { rows: [], rowCount: 0 };
    },
  } as never);

  await listEntities("acc1", { type: "pessoa" });
  assert.match(capturedSql, /type\s*=\s*\$/i);
});

// --- listEntityDocuments ---

test("listEntityDocuments returns 404-sentinel when entity not in account", async () => {
  __setPoolForTest({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as never);

  const result = await listEntityDocuments("acc1", 99, {});
  assert.equal(result, null);
});

test("listEntityDocuments returns entity+documents when found", async () => {
  let callCount = 0;
  __setPoolForTest({
    query: async () => {
      callCount++;
      if (callCount === 1) {
        // entity ownership check
        return { rows: [{ id: 99, type: "pessoa", name: "tatiana guazzelli" }], rowCount: 1 };
      }
      // documents query
      return {
        rows: [{ source_id: "src1", source_type: "granola", parent_url: null, metadata: {}, source_updated: new Date(), confidence: 0.9, first_line: null }],
        rowCount: 1,
      };
    },
  } as never);

  const result = await listEntityDocuments("acc1", 99, {});
  assert.ok(result !== null);
  assert.equal(result!.entity.id, 99);
  assert.equal(result!.documents.length, 1);
});
