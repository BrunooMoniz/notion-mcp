// src/rag/__tests__/brain-feedback-tool.test.ts
// TDD spec 004: brain_feedback MCP tool — cross-account guard, deltas, audit log
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setFeedbackPoolForTest } from "../brain-feedback-tool.js";
import { applyFeedback } from "../feedback.js";
import { UTILITY_WEIGHTS } from "../utility.js";

// ---------------------------------------------------------------------------
// Minimal fake pool for testing applyFeedback via brain_feedback internals
// ---------------------------------------------------------------------------

interface FakeChunkRow {
  account_id: string;
  utility_score: number;
  feedback_count: number;
  last_useful_at: Date | null;
}

function makeFakePool(chunks: Record<string, FakeChunkRow>) {
  const auditRows: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (/SELECT.*brain_chunks/.test(normalized)) {
        const id = params[0] as string;
        const row = chunks[id];
        if (!row) return { rows: [] };
        return { rows: [{ ...row }] };
      }
      if (/UPDATE brain_chunks/.test(normalized)) {
        const newScore = params[0] as number;
        const newCount = params[1] as number;
        const newLast = params[2] as Date | null;
        const id = params[3] as string;
        if (chunks[id]) {
          chunks[id].utility_score = newScore;
          chunks[id].feedback_count = newCount;
          if (newLast) chunks[id].last_useful_at = newLast;
        }
        return { rows: [] };
      }
      if (/INSERT INTO chunk_feedback/.test(normalized)) {
        auditRows.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
    auditRows,
  };
  return pool;
}

afterEach(() => __setFeedbackPoolForTest(null));

// ---------------------------------------------------------------------------
// Tests using applyFeedback directly (same logic the tool uses)
// ---------------------------------------------------------------------------

test("brain_feedback: useful chunk (owner account) → delta +1.5", async () => {
  const chunkId = "c1";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "alice",
      chunkId,
      source: "assistant",
      delta: UTILITY_WEIGHTS.assistant_useful,
    },
    pool as any,
  );

  assert.equal(result.status, "updated");
  assert.ok(Math.abs(result.newScore! - 1.5) < 0.001);
  assert.equal(result.newFeedbackCount, 1);
});

test("brain_feedback: useless chunk (owner account) → delta -1.5", async () => {
  const chunkId = "c2";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "alice",
      chunkId,
      source: "assistant",
      delta: UTILITY_WEIGHTS.assistant_useless,
    },
    pool as any,
  );

  assert.equal(result.status, "updated");
  assert.ok(Math.abs(result.newScore! - (-1.5)) < 0.001);
});

test("brain_feedback: cross-account chunk → not_found (ignored/404)", async () => {
  const chunkId = "c3";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "bob", utility_score: 5, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "alice",   // alice trying to affect bob's chunk
      chunkId,
      source: "assistant",
      delta: UTILITY_WEIGHTS.assistant_useful,
    },
    pool as any,
  );

  assert.equal(result.status, "not_found");
  assert.equal(chunks[chunkId].utility_score, 5, "score must remain unchanged");
});

test("brain_feedback: audit row inserted for each feedback event", async () => {
  const chunkId = "c4";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  await applyFeedback(
    { accountId: "alice", chunkId, source: "assistant", delta: 1.5, query: "test note" },
    pool as any,
  );

  assert.equal(pool.auditRows.length, 1, "should insert one audit row");
  const auditParams = pool.auditRows[0] as unknown[];
  assert.equal(auditParams[0], "alice");   // account_id
  assert.equal(auditParams[1], "c4");      // chunk_id
  assert.equal(auditParams[2], "assistant"); // source
  assert.equal(auditParams[3], 1.5);       // value
  assert.equal(auditParams[4], "test note"); // query
});
