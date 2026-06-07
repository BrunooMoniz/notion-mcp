// src/rag/__tests__/brain-format.test.ts
// P2 — source citations: pure formatting of brain_search hits into results the
// model can cite (title + source_url), and sanitizing useless source links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFromChunkText, sourceUrlOf, toBrainResult } from "../brain-format.js";

// --- titleFromChunkText ------------------------------------------------------

test("titleFromChunkText: strips the leading provenance bracket", () => {
  assert.equal(
    titleFromChunkText("[Reuniões · personal · 2026-06-01 · Nora] Kickoff Nora\nCorpo do chunk…"),
    "Kickoff Nora",
  );
});

test("titleFromChunkText: no bracket → first non-empty line", () => {
  assert.equal(titleFromChunkText("\n\nReunião com Jean\nmais texto"), "Reunião com Jean");
});

test("titleFromChunkText: bracket only (no title) → empty", () => {
  assert.equal(titleFromChunkText("[Calendar · personal · 2026-06-09]"), "");
});

test("titleFromChunkText: empty/whitespace → empty string", () => {
  assert.equal(titleFromChunkText(""), "");
  assert.equal(titleFromChunkText("   \n  "), "");
});

// --- sourceUrlOf -------------------------------------------------------------

test("sourceUrlOf: real Notion/Granola URL passes through", () => {
  assert.equal(sourceUrlOf({ parent_url: "https://www.notion.so/abc", source_type: "notion" }), "https://www.notion.so/abc");
  assert.equal(sourceUrlOf({ parent_url: "https://notes.granola.ai/d/xyz", source_type: "granola" }), "https://notes.granola.ai/d/xyz");
});

test("sourceUrlOf: misleading generic Google Calendar home is dropped (existing data + new)", () => {
  assert.equal(sourceUrlOf({ parent_url: "https://calendar.google.com/calendar/r", source_type: "calendar" }), null);
});

test("sourceUrlOf: calendar WITH a real per-event url passes through", () => {
  assert.equal(
    sourceUrlOf({ parent_url: "https://calendar.google.com/calendar/event?eid=ABC", source_type: "calendar" }),
    "https://calendar.google.com/calendar/event?eid=ABC",
  );
});

test("sourceUrlOf: null/empty → null", () => {
  assert.equal(sourceUrlOf({ parent_url: null, source_type: "notion" }), null);
  assert.equal(sourceUrlOf({ parent_url: "   ", source_type: "notion" }), null);
});

// --- toBrainResult -----------------------------------------------------------

test("toBrainResult: surfaces title + source_url (notion_url kept as alias) + text", () => {
  const hit: any = {
    chunk: {
      text: "[Reuniões · personal · 2026-06-01] Kickoff\ndetalhe",
      parent_url: "https://www.notion.so/abc",
      source_type: "notion",
      workspace: "personal",
      db_name: "Reuniões",
      metadata: { data: "2026-06-01" },
    },
    score: 0.9,
    neighbors: [{ text: "viz" }],
  };
  const r = toBrainResult(hit);
  assert.equal(r.title, "Kickoff");
  assert.equal(r.source_url, "https://www.notion.so/abc");
  assert.equal(r.notion_url, "https://www.notion.so/abc"); // back-compat alias
  assert.equal(r.text, hit.chunk.text);
  assert.equal(r.source_type, "notion");
  assert.equal(r.score, 0.9);
  assert.deepEqual(r.neighbors, ["viz"]);
});

test("toBrainResult: calendar hit with generic home link → source_url null, title still set", () => {
  const hit: any = {
    chunk: {
      text: "[Calendar · personal · 2026-06-09] Dentista\n…",
      parent_url: "https://calendar.google.com/calendar/r",
      source_type: "calendar",
      workspace: "personal",
      db_name: "Calendar",
      metadata: {},
    },
    score: 0.5,
  };
  const r = toBrainResult(hit);
  assert.equal(r.title, "Dentista");
  assert.equal(r.source_url, null);
  assert.equal(r.notion_url, null);
  assert.deepEqual(r.neighbors, []);
});
