// src/rag/__tests__/indexer.test.ts
// F.2.3 — Granola cursor advances by max(created_at), not wall-clock.
// Tests the pure `nextGranolaCursor` helper. Runs WITHOUT any creds.
//
// The helper lives in ./granola-cursor.js (re-exported by indexer.ts). We
// import the standalone module here on purpose: importing indexer.ts would
// pull in notion-source -> clients.ts, which calls process.exit(1) when the
// Notion env vars are absent — so it cannot be imported in a credential-less
// unit test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGranolaCursor } from "../granola-cursor.js";

test("nextGranolaCursor = max(created_at) of listed notes", () => {
  const notes = [
    { created_at: "2026-05-01T00:00:00Z" },
    { created_at: "2026-05-10T00:00:00Z" },
    { created_at: "2026-05-03T00:00:00Z" },
  ];
  assert.equal(nextGranolaCursor(notes), "2026-05-10T00:00:00Z");
});

test("nextGranolaCursor with no notes returns null (keep prior cursor)", () => {
  assert.equal(nextGranolaCursor([]), null);
});

test("nextGranolaCursor ignores notes missing created_at", () => {
  const notes = [
    { created_at: "2026-05-01T00:00:00Z" },
    {},
    { created_at: null },
    { created_at: "2026-05-07T00:00:00Z" },
  ];
  assert.equal(nextGranolaCursor(notes), "2026-05-07T00:00:00Z");
});

test("nextGranolaCursor with only invalid/missing created_at returns null", () => {
  assert.equal(nextGranolaCursor([{}, { created_at: null }]), null);
});
