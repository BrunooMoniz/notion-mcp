// src/rag/__tests__/brain-tool-cites.test.ts
// TDD: written before the implementation. Run first to confirm RED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCites, buildPresentationHint } from "../brain-tool.js";

// ---------- buildCites ----------

test("buildCites: maps results to {icon, title, url, meta} array", () => {
  const results = [
    {
      title: "Kickoff Nora",
      source_url: "https://www.notion.so/abc",
      source_type: "notion",
      db: "Reuniões",
      metadata: { data: "2026-06-04" },
    },
    {
      title: "Sync de Produto",
      source_url: "https://notes.granola.ai/d/xyz",
      source_type: "granola",
      db: null,
      metadata: {},
    },
  ];
  const cites = buildCites(results as any);
  assert.equal(cites.length, 2);
  assert.deepEqual(cites[0], {
    icon: "notion",
    title: "Kickoff Nora",
    url: "https://www.notion.so/abc",
    meta: "2026-06-04", // metadata.data takes priority
  });
  assert.deepEqual(cites[1], {
    icon: "granola",
    title: "Sync de Produto",
    url: "https://notes.granola.ai/d/xyz",
    meta: "granola", // fallback: source_type (db is null, data is undefined)
  });
});

test("buildCites: meta falls back to db when data absent", () => {
  const results = [
    {
      title: "Página",
      source_url: null,
      source_type: "notion",
      db: "Tasks",
      metadata: {},
    },
  ];
  const cites = buildCites(results as any);
  assert.equal(cites[0].meta, "Tasks");
  assert.equal(cites[0].url, null);
});

test("buildCites: empty results → empty array", () => {
  assert.deepEqual(buildCites([]), []);
});

// ---------- buildPresentationHint ----------

test("buildPresentationHint: returns non-empty string instructing citation format", () => {
  const hint = buildPresentationHint([
    { title: "Sync de Produto — 04/06", source_url: "https://notes.granola.ai/d/xyz", source_type: "granola", db: null, metadata: {} } as any,
  ]);
  assert.ok(hint.includes("[1]"), "hint should reference [1]");
  assert.ok(hint.includes("https://notes.granola.ai"), "hint should include url");
});

test("buildPresentationHint: empty results → empty string", () => {
  assert.equal(buildPresentationHint([]), "");
});
