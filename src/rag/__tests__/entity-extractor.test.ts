// src/rag/__tests__/entity-extractor.test.ts
// Pure logic tests — no callHaiku, no DB. Tests the normalization and the
// metadata fast-path (pessoas/attendees → confidence 1.0 without LLM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTITIES_ENABLED, extractEntitiesFromMetadata, parseEntityResponse } from "../entity-extractor.js";

// ENTITIES_ENABLED must be false when env var is absent (default off)
test("ENTITIES_ENABLED is false when env var not set", () => {
  // In test env, ENTITIES_ENABLED env var is not set, so must be false
  assert.equal(ENTITIES_ENABLED, false);
});

// --- metadata fast-path ---

test("extractEntitiesFromMetadata extracts pessoas with confidence 1.0", () => {
  const result = extractEntitiesFromMetadata({ pessoas: ["Tatiana Guazzelli", "Jean"] });
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.confidence === 1.0));
  assert.ok(result.every((r) => r.type === "pessoa"));
  assert.ok(result.map((r) => r.name).includes("Tatiana Guazzelli"));
});

test("extractEntitiesFromMetadata extracts attendees with confidence 1.0", () => {
  const result = extractEntitiesFromMetadata({ attendees: ["Luigi Remor"] });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "pessoa");
  assert.equal(result[0].confidence, 1.0);
  assert.equal(result[0].name, "Luigi Remor");
});

test("extractEntitiesFromMetadata deduplicates across pessoas and attendees", () => {
  const result = extractEntitiesFromMetadata({
    pessoas: ["Jean"],
    attendees: ["Jean", "Luigi"],
  });
  // Jean should appear only once
  const names = result.map((r) => r.name);
  assert.equal(names.filter((n) => n === "Jean").length, 1);
  assert.equal(result.length, 2); // Jean + Luigi
});

test("extractEntitiesFromMetadata returns empty array when no structured fields", () => {
  const result = extractEntitiesFromMetadata({ title: "Some doc" });
  assert.equal(result.length, 0);
});

test("extractEntitiesFromMetadata ignores non-array values", () => {
  const result = extractEntitiesFromMetadata({ pessoas: "not an array" });
  assert.equal(result.length, 0);
});

// --- parseEntityResponse ---

test("parseEntityResponse parses valid JSON array", () => {
  const raw = '[{"name":"Nora Finance","type":"empresa"},{"name":"Bruno","type":"pessoa"}]';
  const result = parseEntityResponse(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "Nora Finance");
  assert.equal(result[0].type, "empresa");
});

test("parseEntityResponse returns [] on invalid JSON", () => {
  const result = parseEntityResponse("not json at all");
  assert.deepEqual(result, []);
});

test("parseEntityResponse returns [] on non-array JSON", () => {
  const result = parseEntityResponse('{"name":"Bruno"}');
  assert.deepEqual(result, []);
});

test("parseEntityResponse drops items with invalid type", () => {
  const raw = '[{"name":"X","type":"invalid"},{"name":"Y","type":"pessoa"}]';
  const result = parseEntityResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Y");
});

test("parseEntityResponse drops items missing name", () => {
  const raw = '[{"type":"pessoa"},{"name":"Jean","type":"pessoa"}]';
  const result = parseEntityResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Jean");
});

test("parseEntityResponse handles LLM wrapping the array in markdown fences", () => {
  const raw = '```json\n[{"name":"Nora","type":"empresa"}]\n```';
  const result = parseEntityResponse(raw);
  assert.equal(result.length, 1);
});
