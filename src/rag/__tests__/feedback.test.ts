// src/rag/__tests__/feedback.test.ts
// TDD spec 004: feedback storage, cross-account guard, score mechanics
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedback,
  type FeedbackSource,
  type ApplyFeedbackResult,
} from "../feedback.js";
import { UTILITY_WEIGHTS } from "../utility.js";

// ---------------------------------------------------------------------------
// Fake pool used by feedback.ts (injectable)
// ---------------------------------------------------------------------------

interface FakeChunkRow {
  account_id: string;
  utility_score: number;
  feedback_count: number;
  last_useful_at: Date | null;
}

type QueryCall = { sql: string; params: unknown[] };

function makeFakePool(chunks: Record<string, FakeChunkRow>) {
  const calls: QueryCall[] = [];

  const pool = {
    query: async (sql: string, params: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      // SELECT for chunk info
      if (/SELECT.*brain_chunks/.test(normalized)) {
        const chunkId = params[0] as string;
        const row = chunks[chunkId];
        if (!row) return { rows: [] };
        return { rows: [row] };
      }
      // UPDATE brain_chunks
      if (/UPDATE brain_chunks/.test(normalized)) {
        const newScore = params[0] as number;
        const newCount = params[1] as number;
        const newLastUseful = params[2] as Date | null;
        const chunkId = params[3] as string;
        if (chunks[chunkId]) {
          chunks[chunkId].utility_score = newScore;
          chunks[chunkId].feedback_count = newCount;
          chunks[chunkId].last_useful_at = newLastUseful ?? chunks[chunkId].last_useful_at;
        }
        return { rows: [] };
      }
      // INSERT into chunk_feedback (audit log)
      if (/INSERT INTO chunk_feedback/.test(normalized)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    calls,
  };
  return pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("applyFeedback: cross-account returns 404 and leaves score unchanged", async () => {
  const chunkId = "chunk-abc";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "account-owner", utility_score: 5, feedback_count: 1, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "account-intruder",  // different account
      chunkId,
      source: "user_thumb",
      delta: UTILITY_WEIGHTS.user_thumb_up,
      query: "test query",
    },
    pool as any,
  );

  assert.equal(result.status, "not_found", "cross-account must return not_found (404)");
  assert.equal(chunks[chunkId].utility_score, 5, "score must be unchanged after cross-account attempt");
});

test("applyFeedback: 👍 👍 👎 accumulates to 3.0 with 0-day decay", async () => {
  const chunkId = "chunk-def";
  const now = new Date();
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };

  const args = {
    accountId: "alice",
    chunkId,
    source: "user_thumb" as FeedbackSource,
    query: "q",
  };

  const pool = makeFakePool(chunks);

  // 👍
  await applyFeedback({ ...args, delta: UTILITY_WEIGHTS.user_thumb_up }, pool as any, now);
  // 👍
  await applyFeedback({ ...args, delta: UTILITY_WEIGHTS.user_thumb_up }, pool as any, now);
  // 👎
  await applyFeedback({ ...args, delta: UTILITY_WEIGHTS.user_thumb_down }, pool as any, now);

  const final = chunks[chunkId];
  assert.ok(
    Math.abs(final.utility_score - 3.0) < 0.01,
    `expected ~3.0, got ${final.utility_score}`,
  );
  assert.equal(final.feedback_count, 3);
});

test("applyFeedback: positive delta returns updated status", async () => {
  const chunkId = "chunk-xyz";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "bob", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "bob",
      chunkId,
      source: "user_thumb",
      delta: UTILITY_WEIGHTS.user_thumb_up,
      query: "some question",
    },
    pool as any,
  );

  assert.equal(result.status, "updated");
  assert.ok(Math.abs(result.newScore! - 3.0) < 0.01);
});

test("applyFeedback: inserts audit row in chunk_feedback", async () => {
  const chunkId = "chunk-audit";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "charlie", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  await applyFeedback(
    {
      accountId: "charlie",
      chunkId,
      source: "assistant",
      delta: UTILITY_WEIGHTS.assistant_useful,
    },
    pool as any,
  );

  const insertCall = pool.calls.find((c) => /INSERT INTO chunk_feedback/.test(c.sql));
  assert.ok(insertCall, "should have inserted an audit row");
});

test("applyFeedback: chunk_id not found returns not_found", async () => {
  const pool = makeFakePool({});

  const result = await applyFeedback(
    {
      accountId: "dave",
      chunkId: "nonexistent-chunk",
      source: "user_thumb",
      delta: 3,
    },
    pool as any,
  );

  assert.equal(result.status, "not_found");
});
