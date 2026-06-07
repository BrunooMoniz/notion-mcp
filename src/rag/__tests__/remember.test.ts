// src/rag/__tests__/remember.test.ts
// Objective #4 — conversation memory. PURE tests for the document builder behind
// the `remember` MCP tool. Runs WITHOUT any DB or Voyage key: buildConversationDocument
// is pure and takes an injected id + clock seam, so source_id and the created date
// are deterministic. The MCP handler wires this doc through the SAME ingest path
// (indexDocument -> upsertChunks) every other source uses; that path is covered by
// indexer/storage tests, so here we only assert the doc shape + isolation reasoning.
import { test } from "node:test";
import assert from "node:assert/strict";
// Import the PURE builder from its standalone module (remember-doc.ts), NOT from
// remember-tool.ts: the latter pulls in search.ts -> notion-source -> clients.ts,
// which process.exit(1)s without Notion env vars (same constraint as granola-cursor).
import { buildConversationDocument } from "../remember-doc.js";

const SEAM = {
  accountId: "alice",
  workspace: "personal",
  id: "abc123",
  now: new Date("2026-06-07T12:00:00.000Z"),
};

test("buildConversationDocument sets source_type 'conversation'", () => {
  const doc = buildConversationDocument({ text: "lembrar disso" }, SEAM);
  assert.equal(doc.source_type, "conversation");
});

test("buildConversationDocument derives a stable source_id from the injected id", () => {
  const doc = buildConversationDocument({ text: "x" }, SEAM);
  assert.equal(doc.source_id, "conversation:abc123");
  // Same seam -> same id (deterministic, no Math.random / Date.now leakage).
  const again = buildConversationDocument({ text: "y" }, SEAM);
  assert.equal(again.source_id, "conversation:abc123");
});

test("buildConversationDocument takes account_id from the context seam, NOT input", () => {
  const doc = buildConversationDocument(
    // an attacker-supplied account_id in input must be ignored entirely
    { text: "x", account_id: "evil", accountId: "evil" } as any,
    SEAM,
  );
  assert.equal(doc.account_id, "alice");
});

test("buildConversationDocument uses the account's default workspace from the seam", () => {
  const doc = buildConversationDocument({ text: "x" }, { ...SEAM, workspace: "globalcripto" });
  assert.equal(doc.workspace, "globalcripto");
});

test("buildConversationDocument carries tags + created date in metadata", () => {
  const doc = buildConversationDocument(
    { text: "x", tags: ["projeto", "nora"] },
    SEAM,
  );
  assert.deepEqual(doc.metadata.tags, ["projeto", "nora"]);
  // created date is the YYYY-MM-DD of the injected clock; also exposed as metadata.data
  // so the existing date filter / context header treat it like any other chunk.
  assert.equal(doc.metadata.created, "2026-06-07");
  assert.equal(doc.metadata.data, "2026-06-07");
});

test("buildConversationDocument has no tags key when none supplied (defaults to [])", () => {
  const doc = buildConversationDocument({ text: "x" }, SEAM);
  assert.deepEqual(doc.metadata.tags, []);
});

test("buildConversationDocument has parent_url null (conversation has no source URL)", () => {
  const doc = buildConversationDocument({ text: "x" }, SEAM);
  assert.equal(doc.parent_url, null);
  assert.equal(doc.db_name, null);
});

test("buildConversationDocument uses the given title for the metadata.title (citation handle)", () => {
  const doc = buildConversationDocument({ text: "corpo da nota", title: "Decisão sobre pricing" }, SEAM);
  assert.equal(doc.metadata.title, "Decisão sobre pricing");
  // The note body is the chunkable text; the title is what brain-format cites.
  assert.ok(doc.text.includes("corpo da nota"));
});

test("buildConversationDocument falls back to a default title when none given", () => {
  const doc = buildConversationDocument({ text: "só o corpo" }, SEAM);
  // a non-empty title is required for a usable citation
  assert.ok(typeof doc.metadata.title === "string" && (doc.metadata.title as string).length > 0);
});

test("buildConversationDocument source_updated is the injected clock (deterministic)", () => {
  const doc = buildConversationDocument({ text: "x" }, SEAM);
  assert.equal(doc.source_updated.toISOString(), "2026-06-07T12:00:00.000Z");
});

test("default id generator (no injected id) produces a conversation: source_id", () => {
  // Omitting `id` exercises the real generator (crypto.randomUUID-based). Still
  // namespaced and stable within a single call.
  const doc = buildConversationDocument({ text: "x" }, { accountId: "bruno", workspace: "personal" });
  assert.match(doc.source_id, /^conversation:[a-z0-9-]+$/i);
});
