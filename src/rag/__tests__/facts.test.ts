// src/rag/__tests__/facts.test.ts
// F2.3 — pure parsing/normalization for temporal facts. NO DB, NO API keys: the
// unit under test (src/rag/facts.ts) has no side effects.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFactsResponse,
  normalizeFact,
  buildFactExtractionPrompt,
} from "../facts.js";

const CTX = { workspace: "personal", source_id: "page-1", source_type: "reuniao" };

// --- parseFactsResponse -----------------------------------------------------

test("parseFactsResponse parses a clean JSON array", () => {
  const raw = JSON.stringify([
    { subject: "Bruno", predicate: "é sócio de", object: "Nora Finance" },
    { subject: "Jorge", predicate: "role", object: "tech lead" },
  ]);
  const out = parseFactsResponse(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].subject, "Bruno");
  assert.equal(out[1].object, "tech lead");
});

test("parseFactsResponse tolerates a ```json fenced block", () => {
  const raw =
    "```json\n" +
    JSON.stringify([{ subject: "Nora", predicate: "emite", object: "BRS" }]) +
    "\n```";
  const out = parseFactsResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].object, "BRS");
});

test("parseFactsResponse tolerates surrounding prose", () => {
  const raw =
    "Claro! Aqui estão os fatos:\n" +
    JSON.stringify([{ subject: "Global Cripto", predicate: "usa", object: "Fireblocks" }]) +
    "\nEspero ter ajudado.";
  const out = parseFactsResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, "Global Cripto");
});

test("parseFactsResponse returns [] on garbage", () => {
  assert.deepEqual(parseFactsResponse("not json at all"), []);
  assert.deepEqual(parseFactsResponse("{ broken"), []);
  assert.deepEqual(parseFactsResponse("[ {nope} ]"), []);
  assert.deepEqual(parseFactsResponse(""), []);
});

test("parseFactsResponse drops items missing subject/predicate/object", () => {
  const raw = JSON.stringify([
    { subject: "Bruno", predicate: "trabalha em", object: "Nora" }, // keep
    { subject: "", predicate: "x", object: "y" }, // drop (empty subject)
    { subject: "A", predicate: "B" }, // drop (no object)
    { predicate: "B", object: "C" }, // drop (no subject)
    null, // drop
    "string", // drop
  ]);
  const out = parseFactsResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, "Bruno");
});

test("parseFactsResponse does not end the array early on a ] inside a string", () => {
  const raw = JSON.stringify([
    { subject: "A]B", predicate: "p", object: "o]x" },
  ]);
  const out = parseFactsResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, "A]B");
  assert.equal(out[0].object, "o]x");
});

// --- normalizeFact ----------------------------------------------------------

test("normalizeFact trims fields and fills provenance from ctx", () => {
  const out = normalizeFact(
    { subject: "  Bruno  ", predicate: " é sócio de ", object: " Nora " },
    CTX,
  );
  assert.ok(out);
  assert.equal(out!.subject, "Bruno");
  assert.equal(out!.predicate, "é sócio de");
  assert.equal(out!.object, "Nora");
  assert.equal(out!.workspace, "personal");
  assert.equal(out!.source_id, "page-1");
  assert.equal(out!.source_type, "reuniao");
});

test("normalizeFact clamps confidence to [0,1]", () => {
  assert.equal(normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: 1.7 }, CTX)!.confidence, 1);
  assert.equal(normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: -0.4 }, CTX)!.confidence, 0);
  assert.equal(normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: 0.65 }, CTX)!.confidence, 0.65);
  assert.equal(normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: "nope" }, CTX)!.confidence, null);
  assert.equal(normalizeFact({ subject: "a", predicate: "b", object: "c" }, CTX)!.confidence, null);
});

test("normalizeFact treats empty/whitespace confidence as null, not 0 (C5)", () => {
  // Number("") === 0 and Number("   ") === 0 — must NOT silently become 0.
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: "" }, CTX)!.confidence,
    null,
  );
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: "   " }, CTX)!.confidence,
    null,
  );
  // A real numeric string still parses.
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: "0.5" }, CTX)!.confidence,
    0.5,
  );
  // 0 as an actual number is still 0 (not null).
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", confidence: 0 }, CTX)!.confidence,
    0,
  );
});

test("normalizeFact rejects impossible ISO-shaped dates (C6)", () => {
  // Regex-shaped but not real dates → null.
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", valid_from: "2026-13-45" }, CTX)!.valid_from,
    null,
  );
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", valid_from: "2026-02-30" }, CTX)!.valid_from,
    null,
  );
  // Real date is kept.
  assert.equal(
    normalizeFact({ subject: "a", predicate: "b", object: "c", valid_from: "2026-02-28" }, CTX)!.valid_from,
    "2026-02-28",
  );
});

test("normalizeFact rejects non-ISO dates (sets null), keeps valid ones", () => {
  const ok = normalizeFact(
    { subject: "a", predicate: "b", object: "c", valid_from: "2026-01-15", valid_to: "2026-06-01" },
    CTX,
  );
  assert.equal(ok!.valid_from, "2026-01-15");
  assert.equal(ok!.valid_to, "2026-06-01");

  const bad = normalizeFact(
    { subject: "a", predicate: "b", object: "c", valid_from: "15/01/2026", valid_to: "soon" },
    CTX,
  );
  assert.equal(bad!.valid_from, null);
  assert.equal(bad!.valid_to, null);
});

test("normalizeFact drops items missing subject/predicate/object", () => {
  assert.equal(normalizeFact({ subject: "a", predicate: "b" }, CTX), null);
  assert.equal(normalizeFact({ subject: "", predicate: "b", object: "c" }, CTX), null);
  assert.equal(normalizeFact({ predicate: "b", object: "c" }, CTX), null);
  assert.equal(normalizeFact(null, CTX), null);
  assert.equal(normalizeFact("string", CTX), null);
});

test("normalizeFact keeps an object metadata, ignores non-object metadata", () => {
  const withMeta = normalizeFact(
    { subject: "a", predicate: "b", object: "c", metadata: { src: "x" } },
    CTX,
  );
  assert.deepEqual(withMeta!.metadata, { src: "x" });
  const noMeta = normalizeFact(
    { subject: "a", predicate: "b", object: "c", metadata: "nope" },
    CTX,
  );
  assert.equal(noMeta!.metadata, undefined);
});

// --- buildFactExtractionPrompt ----------------------------------------------

test("buildFactExtractionPrompt contains the passage and the [] instruction", () => {
  const passage = "Bruno é co-founder da Nora Finance e da Global Cripto.";
  const prompt = buildFactExtractionPrompt(passage, CTX);
  assert.ok(prompt.includes(passage));
  assert.ok(prompt.includes("[]"));
  // mentions subject-predicate-object framing
  assert.match(prompt, /subject/i);
  assert.match(prompt, /predicate/i);
  assert.match(prompt, /object/i);
});
