// src/rag/__tests__/granola-source.test.ts
// NOTE: per repo test convention, unit tests live in src/rag/__tests__/ so the
// `npm test` glob (src/rag/__tests__/*.test.ts) runs them. The unit under test
// is buildNoteText (and the GRANOLA_INDEX_TRANSCRIPT gate) from
// src/rag/granola-source.ts. No creds/network needed — buildNoteText is pure.
//
// Task F.1.6: raw Granola transcript is noise + sensitive content; by default
// it must NOT be indexed. Gated by GRANOLA_INDEX_TRANSCRIPT (default false).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildNoteText } from "../granola-source.js";

afterEach(() => {
  delete process.env.GRANOLA_INDEX_TRANSCRIPT;
});

test("buildNoteText excludes transcript by default", () => {
  const note = {
    title: "Reunião",
    summary: "resumo aqui",
    transcript: [{ speaker: { diarization_label: "Bruno" }, text: "fala sensível salário" }],
  };
  const text = buildNoteText(note as any);
  assert.ok(text.includes("resumo aqui"));
  assert.ok(!text.includes("salário"));
  assert.ok(!text.includes("## Transcript"));
});

test("buildNoteText includes transcript only when GRANOLA_INDEX_TRANSCRIPT=true", () => {
  process.env.GRANOLA_INDEX_TRANSCRIPT = "true";
  const note = {
    title: "Reunião",
    summary: "resumo",
    transcript: [{ speaker: { diarization_label: "Bruno" }, text: "conteudo transcrito" }],
  };
  const text = buildNoteText(note as any);
  assert.ok(text.includes("conteudo transcrito"));
  assert.ok(text.includes("## Transcript"));
});
