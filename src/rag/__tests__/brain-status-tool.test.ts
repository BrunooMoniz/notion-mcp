// src/rag/__tests__/brain-status-tool.test.ts
// TDD: red before implementation, green after.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBrainStatus,
  type BrainStatusDeps,
} from "../brain-status-tool.js";
import type { StatusSource } from "../status.js";

// ---------- helpers ---------------------------------------------------------

function makeSource(overrides: Partial<StatusSource> = {}): StatusSource {
  return {
    worker: "indexer",
    source: "notion-personal",
    ok: true,
    last_run_at: "2026-06-04T06:00:00.000Z",
    sync_last_at: "2026-06-04T05:55:00.000Z",
    age_seconds: 7200,
    stale: false,
    counts: { documents: 10, chunks: 50 },
    error: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BrainStatusDeps> = {}): BrainStatusDeps {
  return {
    getStatus: async (accountId) => [
      makeSource({ source: `notion-${accountId}` }),
    ],
    getBrainCounts: async (_accountId) => ({
      bySource: [{ source_type: "notion", documents: 10, chunks: 50, last_indexed_at: new Date("2026-06-04") }],
      totals: { documents: 10, chunks: 50 },
    }),
    isRunning: (_accountId) => false,
    ...overrides,
  };
}

// ---------- shape tests -----------------------------------------------------

test("buildBrainStatus returns running flag from isRunning", async () => {
  const deps = makeDeps({ isRunning: (_id) => true });
  const result = await buildBrainStatus("acct-1", deps);
  assert.equal(result.running, true);
});

test("buildBrainStatus returns running=false when not running", async () => {
  const deps = makeDeps({ isRunning: (_id) => false });
  const result = await buildBrainStatus("acct-1", deps);
  assert.equal(result.running, false);
});

test("buildBrainStatus has sources array with expected fields", async () => {
  const deps = makeDeps();
  const result = await buildBrainStatus("acct-1", deps);
  assert.ok(Array.isArray(result.sources));
  assert.equal(result.sources.length, 1);
  const src = result.sources[0];
  assert.ok("source" in src, "missing source");
  assert.ok("ok" in src, "missing ok");
  assert.ok("last_run_at" in src, "missing last_run_at");
  assert.ok("age_seconds" in src, "missing age_seconds");
  assert.ok("stale" in src, "missing stale");
  // error field present (nullable)
  assert.ok("error" in src, "missing error");
});

test("buildBrainStatus has counts with bySource and totals", async () => {
  const deps = makeDeps();
  const result = await buildBrainStatus("acct-1", deps);
  assert.ok(result.counts, "missing counts");
  assert.ok(Array.isArray(result.counts.bySource), "counts.bySource not an array");
  assert.ok(typeof result.counts.totals === "object", "counts.totals not an object");
  assert.ok("documents" in result.counts.totals, "missing totals.documents");
  assert.ok("chunks" in result.counts.totals, "missing totals.chunks");
});

test("buildBrainStatus passes accountId to getStatus and getBrainCounts", async () => {
  const capturedIds: string[] = [];
  const deps = makeDeps({
    getStatus: async (id) => { capturedIds.push(`status:${id}`); return []; },
    getBrainCounts: async (id) => { capturedIds.push(`counts:${id}`); return { bySource: [], totals: { documents: 0, chunks: 0 } }; },
  });
  await buildBrainStatus("my-account", deps);
  assert.ok(capturedIds.includes("status:my-account"), "getStatus not called with accountId");
  assert.ok(capturedIds.includes("counts:my-account"), "getBrainCounts not called with accountId");
});

test("buildBrainStatus maps stale sources correctly", async () => {
  const deps = makeDeps({
    getStatus: async (_id) => [
      makeSource({ stale: true, ok: true, error: null }),
    ],
  });
  const result = await buildBrainStatus("acct-1", deps);
  assert.equal(result.sources[0].stale, true);
});

test("buildBrainStatus maps error field from StatusSource", async () => {
  const deps = makeDeps({
    getStatus: async (_id) => [
      makeSource({ ok: false, error: "Connection timeout" }),
    ],
  });
  const result = await buildBrainStatus("acct-1", deps);
  assert.equal(result.sources[0].ok, false);
  assert.equal(result.sources[0].error, "Connection timeout");
});

test("buildBrainStatus handles empty sources", async () => {
  const deps = makeDeps({
    getStatus: async (_id) => [],
    getBrainCounts: async (_id) => ({ bySource: [], totals: { documents: 0, chunks: 0 } }),
  });
  const result = await buildBrainStatus("acct-1", deps);
  assert.deepEqual(result.sources, []);
  assert.equal(result.counts.totals.documents, 0);
  assert.equal(result.counts.totals.chunks, 0);
});
