// src/rag/__tests__/brain-list-documents-tool.test.ts
// TDD: red before implementation, green after.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleBrainListDocuments,
  type BrainListDocumentsDeps,
  type BrainListDocumentsArgs,
} from "../brain-list-documents-tool.js";
import type { BrainDocument } from "../storage.js";

// ---------- helpers ---------------------------------------------------------

function makeDoc(overrides: Partial<BrainDocument> = {}): BrainDocument {
  return {
    source_id: "page-1",
    source_type: "notion",
    db_name: "Reuniões",
    workspace: "personal",
    parent_url: "https://notion.so/abc",
    title: "Kickoff Nora",
    doc_date: "2026-06-04",
    ...overrides,
  };
}

function makeDeps(docs: BrainDocument[] = [makeDoc()]): BrainListDocumentsDeps {
  return {
    listBrainDocuments: async (_accountId, _opts) => docs,
  };
}

// ---------- tests -----------------------------------------------------------

test("handleBrainListDocuments returns documents array", async () => {
  const deps = makeDeps([makeDoc(), makeDoc({ source_id: "page-2", title: "Reunião B" })]);
  const result = await handleBrainListDocuments("acct-1", {}, deps);
  assert.ok(Array.isArray(result.documents), "documents must be an array");
  assert.equal(result.documents.length, 2);
});

test("handleBrainListDocuments clamps limit to max 50", async () => {
  const capturedOpts: unknown[] = [];
  const deps: BrainListDocumentsDeps = {
    listBrainDocuments: async (_id, opts) => { capturedOpts.push(opts); return []; },
  };
  await handleBrainListDocuments("acct-1", { limit: 99 }, deps);
  assert.equal((capturedOpts[0] as any).limit, 50, "limit should be clamped to 50");
});

test("handleBrainListDocuments uses default limit 20 when not specified", async () => {
  const capturedOpts: unknown[] = [];
  const deps: BrainListDocumentsDeps = {
    listBrainDocuments: async (_id, opts) => { capturedOpts.push(opts); return []; },
  };
  await handleBrainListDocuments("acct-1", {}, deps);
  assert.equal((capturedOpts[0] as any).limit, 20);
});

test("handleBrainListDocuments passes source_type filter through", async () => {
  const capturedOpts: unknown[] = [];
  const deps: BrainListDocumentsDeps = {
    listBrainDocuments: async (_id, opts) => { capturedOpts.push(opts); return []; },
  };
  await handleBrainListDocuments("acct-1", { source_type: "granola" }, deps);
  assert.equal((capturedOpts[0] as any).sourceType, "granola");
});

test("handleBrainListDocuments passes q filter through", async () => {
  const capturedOpts: unknown[] = [];
  const deps: BrainListDocumentsDeps = {
    listBrainDocuments: async (_id, opts) => { capturedOpts.push(opts); return []; },
  };
  await handleBrainListDocuments("acct-1", { q: "nora" }, deps);
  assert.equal((capturedOpts[0] as any).q, "nora");
});

test("handleBrainListDocuments passes offset through", async () => {
  const capturedOpts: unknown[] = [];
  const deps: BrainListDocumentsDeps = {
    listBrainDocuments: async (_id, opts) => { capturedOpts.push(opts); return []; },
  };
  await handleBrainListDocuments("acct-1", { offset: 20 }, deps);
  assert.equal((capturedOpts[0] as any).offset, 20);
});

test("handleBrainListDocuments passes accountId to listBrainDocuments", async () => {
  const capturedIds: string[] = [];
  const deps: BrainListDocumentsDeps = {
    listBrainDocuments: async (id, _opts) => { capturedIds.push(id); return []; },
  };
  await handleBrainListDocuments("my-friend-account", {}, deps);
  assert.ok(capturedIds.includes("my-friend-account"), "accountId not passed");
});

test("handleBrainListDocuments returns empty documents gracefully", async () => {
  const result = await handleBrainListDocuments("acct-1", {}, makeDeps([]));
  assert.deepEqual(result.documents, []);
});

test("handleBrainListDocuments document has expected fields", async () => {
  const result = await handleBrainListDocuments("acct-1", {}, makeDeps([makeDoc()]));
  const doc = result.documents[0];
  assert.ok("source_id" in doc, "missing source_id");
  assert.ok("source_type" in doc, "missing source_type");
  assert.ok("title" in doc, "missing title");
  assert.ok("parent_url" in doc, "missing parent_url");
});
