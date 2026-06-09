// src/portal/__tests__/invites-format.test.ts
// TDD — written BEFORE the implementation. Run first to confirm RED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateInviteCode, hashInvite, normalizeInviteCode } from "../invites.js";

// ---------- generateInviteCode format ----------

test("generateInviteCode returns ZIN-XXXX-XXXX with safe charset", () => {
  const code = generateInviteCode();
  assert.match(
    code,
    /^ZIN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
    `Expected ZIN-XXXX-XXXX, got: ${code}`,
  );
});

test("generateInviteCode: two consecutive codes are not equal", () => {
  assert.notEqual(generateInviteCode(), generateInviteCode());
});

// ---------- normalizeInviteCode ----------

test("normalizeInviteCode: ZIN- prefix stripped, uppercased, hyphens removed", () => {
  assert.equal(normalizeInviteCode("ZIN-ABCD-2345"), "ABCD2345");
});

test("normalizeInviteCode: lowercase zin- prefix handled", () => {
  assert.equal(normalizeInviteCode("zin-abcd-2345"), "ABCD2345");
});

test("normalizeInviteCode: ZIN without hyphen separator handled", () => {
  assert.equal(normalizeInviteCode("ZINABCD2345"), "ABCD2345");
});

test("normalizeInviteCode: extra spaces trimmed", () => {
  assert.equal(normalizeInviteCode("  ZIN-ABCD-2345  "), "ABCD2345");
});

test("normalizeInviteCode: legacy 24-char hex code passes through unchanged", () => {
  const legacy = "a1b2c3d4e5f6a7b8c9d0e1f2";
  assert.equal(normalizeInviteCode(legacy), legacy);
});

test("normalizeInviteCode: random non-ZIN string passes through (trimmed)", () => {
  assert.equal(normalizeInviteCode("  someRandomCode  "), "someRandomCode");
});

// ---------- hashInvite normalization ----------

test("hashInvite: zin-abcd-2345 === ZIN-ABCD-2345 (case+prefix normalization)", () => {
  assert.equal(hashInvite("zin-abcd-2345"), hashInvite("ZIN-ABCD-2345"));
});

test("hashInvite: ABCD2345 without prefix === ZIN-ABCD-2345 (no double-strip)", () => {
  // After normalizing ZIN-ABCD-2345 → ABCD2345, hashInvite("ABCD2345") should equal hashInvite("ZIN-ABCD-2345")
  // because normalizeInviteCode("ABCD2345") = "ABCD2345" (no ZIN prefix) so hash is sha256("ABCD2345")
  // and normalizeInviteCode("ZIN-ABCD-2345") = "ABCD2345" so same hash.
  assert.equal(hashInvite("ABCD2345"), hashInvite("ZIN-ABCD-2345"));
});

test("hashInvite: legacy hex code is NOT altered by normalization", () => {
  const legacy = "a1b2c3d4e5f6a7b8c9d0e1f2";
  const expectedHash = createHash("sha256").update(legacy).digest("hex");
  assert.equal(hashInvite(legacy), expectedHash);
});

test("hashInvite: trims whitespace (existing behavior preserved)", () => {
  assert.equal(hashInvite("ZIN-ABCD-2345"), hashInvite("  ZIN-ABCD-2345  "));
});
