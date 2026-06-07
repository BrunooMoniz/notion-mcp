// src/rag/__tests__/brain-tool-enum.test.ts
// Objective #4 — the brain_search source_type / exclude_source_type enums must
// accept the conversation-memory source ("conversation") AND the real-but-missing
// "web" source. We assert against the exported SOURCE_TYPE_FILTER_VALUES constant
// (the single source of truth the Zod enums are built from) so the filter can
// never silently drop a valid source_type again. Pure: no DB, no Voyage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE_TYPE_FILTER_VALUES } from "../brain-tool.js";

test("brain_search filter enum includes the conversation-memory source", () => {
  assert.ok(SOURCE_TYPE_FILTER_VALUES.includes("conversation"));
});

test("brain_search filter enum includes the web source", () => {
  assert.ok(SOURCE_TYPE_FILTER_VALUES.includes("web"));
});

test("brain_search filter enum still includes the original three sources", () => {
  for (const s of ["notion", "granola", "calendar"] as const) {
    assert.ok(SOURCE_TYPE_FILTER_VALUES.includes(s), `missing ${s}`);
  }
});

test("brain_search filter enum covers exactly the five real source types", () => {
  assert.deepEqual(
    [...SOURCE_TYPE_FILTER_VALUES].sort(),
    ["calendar", "conversation", "granola", "notion", "web"],
  );
});
