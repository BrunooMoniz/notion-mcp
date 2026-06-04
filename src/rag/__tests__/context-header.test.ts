// src/rag/__tests__/context-header.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextHeader } from "../context-header.js";
import type { IndexableDocument } from "../types.js";

function doc(overrides: Partial<IndexableDocument>): IndexableDocument {
  return {
    source_type: "notion",
    source_id: "abc",
    workspace: "personal",
    db_name: "Reuniões",
    parent_url: "https://www.notion.so/abc",
    text: "",
    metadata: {},
    source_updated: new Date("2026-04-24T10:00:00.000Z"),
    ...overrides,
  };
}

test("notion-style doc → bracketed prefix with db_name · workspace · date · frente", () => {
  const header = buildContextHeader(
    doc({
      text: "# Talos\n\n**Frente:** Global Cripto\n\nconteúdo da reunião.",
      metadata: { data: "2026-04-24T13:00:00.000-03:00", frente: "Global Cripto" },
      db_name: "Reuniões",
      workspace: "personal",
    }),
  );
  assert.equal(header, "[Reuniões · personal · 2026-04-24 · Global Cripto] Talos");
  assert.ok(!header.includes("\n"));
});

test("doc with no title → bracket only (no trailing title)", () => {
  const header = buildContextHeader(
    doc({
      text: "sem heading nenhum, só corpo de texto.",
      metadata: {},
      db_name: "Reuniões",
      workspace: "personal",
    }),
  );
  assert.equal(header, "[Reuniões · personal]");
});

test("doc with no metadata parts → just the title", () => {
  const header = buildContextHeader(
    doc({
      text: "# Só o Título\n\ncorpo.",
      metadata: {},
      db_name: null,
      workspace: null,
    }),
  );
  assert.equal(header, "Só o Título");
});

test("date is truncated to YYYY-MM-DD", () => {
  const header = buildContextHeader(
    doc({
      text: "# Evento",
      metadata: { data: "2026-12-31T23:59:59.000Z" },
      db_name: null,
      workspace: null,
    }),
  );
  assert.equal(header, "[2026-12-31] Evento");
});

test("title falls back to metadata.title when no heading line", () => {
  const header = buildContextHeader(
    doc({
      text: "corpo sem heading.",
      metadata: { title: "Título dos Metadados" },
      db_name: null,
      workspace: null,
    }),
  );
  assert.equal(header, "Título dos Metadados");
});

test("empty doc → empty string", () => {
  const header = buildContextHeader(
    doc({ text: "", metadata: {}, db_name: null, workspace: null }),
  );
  assert.equal(header, "");
});

test("non-string frente is ignored", () => {
  const header = buildContextHeader(
    doc({
      text: "# Reunião",
      metadata: { frente: ["a", "b"] },
      db_name: "Reuniões",
      workspace: null,
    }),
  );
  assert.equal(header, "[Reuniões] Reunião");
});

test("uses first matching heading (## / ###) and strips leading #'s", () => {
  const header = buildContextHeader(
    doc({
      text: "## Subtítulo\n\ncorpo.",
      metadata: {},
      db_name: null,
      workspace: null,
    }),
  );
  assert.equal(header, "Subtítulo");
});
