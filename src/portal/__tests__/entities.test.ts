// src/portal/__tests__/entities.test.ts
// Unit tests for GET /portal/brain/entities and GET /portal/brain/entities/:id/documents.
// Uses the __setPoolForTest seam — no live DB, no server.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setPoolForTest } from "../../rag/storage.js";

afterEach(() => {
  __setPoolForTest(null);
});

// We test the storage functions directly (the route handler delegates to them).
// Route-level isolation (session, accountId from res.locals) is tested via
// the session.test.ts pattern — here we focus on the DB layer behavior.

import { listEntities, listEntityDocuments } from "../../rag/entity-storage.js";

test("listEntities returns empty result when table returns no rows", async () => {
  __setPoolForTest({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as never);

  const result = await listEntities("acc-a", {});
  assert.deepEqual(result.entities, []);
  assert.equal(result.total, 0);
});

test("listEntities maps rows correctly", async () => {
  let callCount = 0;
  __setPoolForTest({
    query: async () => {
      callCount++;
      if (callCount === 1) {
        // COUNT query
        return { rows: [{ count: "1" }], rowCount: 1 };
      }
      // Main query
      return {
        rows: [{ id: 42, type: "pessoa", name: "tatiana guazzelli", aliases: ["tatiana"], mention_count: "17", doc_count: "5" }],
        rowCount: 1,
      };
    },
  } as never);

  const result = await listEntities("acc-a", {});
  assert.equal(result.total, 1);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].id, 42);
  assert.equal(result.entities[0].mention_count, 17);
  assert.equal(result.entities[0].doc_count, 5);
});

test("listEntityDocuments returns null for entity belonging to a different account (404 guard)", async () => {
  // Entity exists but for account-B, not account-A
  __setPoolForTest({
    query: async () => ({ rows: [], rowCount: 0 }), // ownership check returns nothing
  } as never);

  const result = await listEntityDocuments("account-A", 99, {});
  assert.equal(result, null, "must return null when entity not found for this account");
});

test("listEntityDocuments returns entity + documents for correct account", async () => {
  let callCount = 0;
  __setPoolForTest({
    query: async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ id: 42, type: "empresa", name: "nora finance" }], rowCount: 1 };
      }
      if (callCount === 2) {
        return {
          rows: [{
            source_id: "src-1",
            source_type: "granola",
            parent_url: null,
            metadata: {},
            source_updated: new Date("2026-05-10"),
            confidence: 0.91,
            first_line: "[Granola] Reunião Nora",
          }],
          rowCount: 1,
        };
      }
      // count query
      return { rows: [{ count: "1" }], rowCount: 1 };
    },
  } as never);

  const result = await listEntityDocuments("account-A", 42, {});
  assert.ok(result !== null);
  assert.equal(result!.entity.id, 42);
  assert.equal(result!.entity.name, "nora finance");
  assert.equal(result!.documents.length, 1);
  assert.equal(result!.documents[0].source_id, "src-1");
  assert.equal(result!.documents[0].doc_date, "2026-05-10");
  assert.equal(result!.total, 1);
});
