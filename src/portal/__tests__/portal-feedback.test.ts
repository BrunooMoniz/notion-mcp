// src/portal/__tests__/portal-feedback.test.ts
// TDD spec 004: POST /portal/feedback — user thumbs up/down, cross-account guard
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFeedback } from "../../rag/feedback.js";
import { UTILITY_WEIGHTS } from "../../rag/utility.js";

// ---------------------------------------------------------------------------
// Fake pool for testing feedback via the same applyFeedback function
// ---------------------------------------------------------------------------

interface FakeChunkRow {
  account_id: string;
  utility_score: number;
  feedback_count: number;
  last_useful_at: Date | null;
}

function makeFakePool(chunks: Record<string, FakeChunkRow>) {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      const norm = sql.replace(/\s+/g, " ").trim();
      calls.push(norm);
      if (/SELECT.*brain_chunks/.test(norm)) {
        const id = params[0] as string;
        const row = chunks[id];
        if (!row) return { rows: [] };
        return { rows: [{ ...row }] };
      }
      if (/UPDATE brain_chunks/.test(norm)) {
        const id = params[3] as string;
        if (chunks[id]) {
          chunks[id].utility_score = params[0] as number;
          chunks[id].feedback_count = params[1] as number;
        }
        return { rows: [] };
      }
      if (/INSERT INTO chunk_feedback/.test(norm)) return { rows: [] };
      return { rows: [] };
    },
    calls,
  };
  return pool;
}

// ---------------------------------------------------------------------------
// Tests simulating what POST /portal/feedback does
// ---------------------------------------------------------------------------

test("portal feedback 👍: applies +3.0 delta to chunk for account", async () => {
  const chunkId = "chunk-portal-1";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  // Simulate what the /portal/feedback handler does
  const result = await applyFeedback(
    {
      accountId: "alice",
      chunkId,
      source: "user_thumb",
      delta: UTILITY_WEIGHTS.user_thumb_up, // +3.0
      query: "test query from chat",
    },
    pool as any,
  );

  assert.equal(result.status, "updated");
  assert.ok(Math.abs(result.newScore! - 3.0) < 0.001);
  assert.equal(result.newFeedbackCount, 1);
});

test("portal feedback 👎: applies -3.0 delta to chunk for account", async () => {
  const chunkId = "chunk-portal-2";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 3, feedback_count: 1, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "alice",
      chunkId,
      source: "user_thumb",
      delta: UTILITY_WEIGHTS.user_thumb_down, // -3.0
      query: "bad result",
    },
    pool as any,
  );

  assert.equal(result.status, "updated");
  assert.ok(Math.abs(result.newScore! - 0.0) < 0.01, `expected ~0.0, got ${result.newScore}`);
});

test("portal feedback cross-account: returns not_found, score unchanged", async () => {
  const chunkId = "chunk-portal-3";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "bob", utility_score: 5, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  const result = await applyFeedback(
    {
      accountId: "alice", // alice trying to vote on bob's chunk
      chunkId,
      source: "user_thumb",
      delta: UTILITY_WEIGHTS.user_thumb_up,
    },
    pool as any,
  );

  assert.equal(result.status, "not_found");
  assert.equal(chunks[chunkId].utility_score, 5, "score must be unchanged");
});

test("portal feedback: idempotency — same delta twice doubles count", async () => {
  // The spec says "1 voto por chunk por sessão de chat" is controlled client-side.
  // Server-side is idempotent via (account,chunk,source,1h window) — but our
  // simple applyFeedback accumulates. The route-level idempotency check is tested
  // at the HTTP level; here we just confirm each call increments feedback_count.
  const chunkId = "chunk-portal-4";
  const chunks: Record<string, FakeChunkRow> = {
    [chunkId]: { account_id: "alice", utility_score: 0, feedback_count: 0, last_useful_at: null },
  };
  const pool = makeFakePool(chunks);

  await applyFeedback({ accountId: "alice", chunkId, source: "user_thumb", delta: 3 }, pool as any);
  await applyFeedback({ accountId: "alice", chunkId, source: "user_thumb", delta: 3 }, pool as any);

  assert.equal(chunks[chunkId].feedback_count, 2);
  assert.ok(Math.abs(chunks[chunkId].utility_score - 6) < 0.01);
});
