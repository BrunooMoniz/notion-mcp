// src/billing/__tests__/credits.test.ts
// F7 — Unit tests for the unified credit model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsFor, CREDIT_RATES } from "../credits.js";

// ---------------------------------------------------------------------------
// creditsFor — pure function
// ---------------------------------------------------------------------------

test("creditsFor: search = 1 credit per call", () => {
  assert.equal(creditsFor("search", 1), 1);
  assert.equal(creditsFor("search", 10), 10);
});

test("creditsFor: ask = 2 credits per call", () => {
  assert.equal(creditsFor("ask", 1), 2);
  assert.equal(creditsFor("ask", 5), 10);
});

test("creditsFor: action = 2 credits per call", () => {
  assert.equal(creditsFor("action", 1), 2);
  assert.equal(creditsFor("action", 3), 6);
});

test("creditsFor: index_pages = 0.2 credits per page", () => {
  assert.equal(creditsFor("index_pages", 1), 0.2);
  assert.equal(creditsFor("index_pages", 10), 2);
  assert.equal(creditsFor("index_pages", 5), 1);
});

test("creditsFor: unknown metric = 0", () => {
  assert.equal(creditsFor("llm_input_tokens", 1_000_000), 0);
  assert.equal(creditsFor("llm_output_tokens", 500_000), 0);
  assert.equal(creditsFor("chunks", 100), 0);
  assert.equal(creditsFor("embed_tokens", 5000), 0);
  assert.equal(creditsFor("nonexistent", 99), 0);
});

test("creditsFor: zero quantity = 0 credits", () => {
  assert.equal(creditsFor("search", 0), 0);
  assert.equal(creditsFor("ask", 0), 0);
});

test("CREDIT_RATES exports expected keys", () => {
  assert.equal(CREDIT_RATES.search, 1);
  assert.equal(CREDIT_RATES.ask, 2);
  assert.equal(CREDIT_RATES.action, 2);
  assert.equal(CREDIT_RATES.index_pages, 0.2);
});
