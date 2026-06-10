// src/__tests__/llm-usage.test.ts
// TDD tests for src/llm-usage.ts — pure, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordLlmUsage, type LlmUsage } from "../llm-usage.js";

test("recordLlmUsage: writes llm_input_tokens and llm_output_tokens", async () => {
  const calls: Array<[string, string, number]> = [];
  const writer = async (accountId: string, metric: string, qty: number) => {
    calls.push([accountId, metric, qty]);
  };

  const usage: LlmUsage = { input_tokens: 300, output_tokens: 150 };
  await recordLlmUsage("acct-1", usage, "ask", writer);

  assert.equal(calls.length, 2);
  const inputCall = calls.find(([, m]) => m === "llm_input_tokens");
  const outputCall = calls.find(([, m]) => m === "llm_output_tokens");
  assert.ok(inputCall, "expected llm_input_tokens write");
  assert.equal(inputCall[0], "acct-1");
  assert.equal(inputCall[2], 300);
  assert.ok(outputCall, "expected llm_output_tokens write");
  assert.equal(outputCall[0], "acct-1");
  assert.equal(outputCall[2], 150);
});

test("recordLlmUsage: skips zero input_tokens", async () => {
  const calls: Array<[string, string, number]> = [];
  const writer = async (accountId: string, metric: string, qty: number) => {
    calls.push([accountId, metric, qty]);
  };

  const usage: LlmUsage = { input_tokens: 0, output_tokens: 50 };
  await recordLlmUsage("acct-1", usage, "ask", writer);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "llm_output_tokens");
});

test("recordLlmUsage: skips zero output_tokens", async () => {
  const calls: Array<[string, string, number]> = [];
  const writer = async (accountId: string, metric: string, qty: number) => {
    calls.push([accountId, metric, qty]);
  };

  const usage: LlmUsage = { input_tokens: 100, output_tokens: 0 };
  await recordLlmUsage("acct-1", usage, "classifier", writer);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "llm_input_tokens");
});

test("recordLlmUsage: no-ops when both tokens are zero", async () => {
  const calls: Array<[string, string, number]> = [];
  const writer = async (accountId: string, metric: string, qty: number) => {
    calls.push([accountId, metric, qty]);
  };

  const usage: LlmUsage = { input_tokens: 0, output_tokens: 0 };
  await recordLlmUsage("acct-1", usage, "ask", writer);

  assert.equal(calls.length, 0);
});

test("recordLlmUsage: uses the injected writer (no real DB call)", async () => {
  let writerCalled = false;
  const writer = async (_accountId: string, _metric: string, _qty: number) => {
    writerCalled = true;
  };

  await recordLlmUsage("acct-x", { input_tokens: 10, output_tokens: 5 }, "router", writer);
  assert.equal(writerCalled, true);
});

test("recordLlmUsage: passes correct accountId to both writes", async () => {
  const accountIds: string[] = [];
  const writer = async (accountId: string, _metric: string, _qty: number) => {
    accountIds.push(accountId);
  };

  await recordLlmUsage("friend-42", { input_tokens: 100, output_tokens: 200 }, "ask", writer);
  assert.deepEqual(accountIds, ["friend-42", "friend-42"]);
});
