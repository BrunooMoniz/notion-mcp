// src/rag/__tests__/status.test.ts
// Observability: pure-logic tests for the /status payload + staleness.
// These run WITHOUT POSTGRES_URL — staleness() and summarizeStatus() are pure
// and never touch a pool, so a dead source surfaces as stale/failing in a
// fully unit-testable way.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  staleness,
  summarizeStatus,
  STALE_THRESHOLD_SECONDS,
  type StatusRow,
} from "../status.js";

// --- staleness(ageSeconds, thresholdSeconds) boundaries ---------------------

test("staleness: age below threshold is not stale", () => {
  assert.equal(staleness(100, 200), false);
});

test("staleness: age exactly at threshold is NOT stale (strict >)", () => {
  assert.equal(staleness(200, 200), false);
});

test("staleness: age above threshold is stale", () => {
  assert.equal(staleness(201, 200), true);
});

test("staleness: uses default threshold when omitted", () => {
  assert.equal(staleness(STALE_THRESHOLD_SECONDS + 1), true);
  assert.equal(staleness(STALE_THRESHOLD_SECONDS - 1), false);
});

// --- summarizeStatus(rows, now) maps raw latest-rows -> /status payload -----

const NOW = new Date("2026-06-04T12:00:00.000Z");

function row(over: Partial<StatusRow>): StatusRow {
  return {
    worker: "indexer",
    source: "notion-personal",
    ok: true,
    counts: { documents: 3, chunks: 9 },
    error: null,
    last_run_at: new Date("2026-06-04T11:59:00.000Z"), // 60s ago
    sync_last_at: null,
    ...over,
  };
}

test("summarizeStatus computes age_seconds from last_run_at relative to now", () => {
  const out = summarizeStatus([row({ last_run_at: new Date("2026-06-04T11:00:00.000Z") })], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].age_seconds, 3600);
});

test("summarizeStatus marks a source stale when age exceeds the threshold", () => {
  // 4h ago > 3h threshold
  const out = summarizeStatus([row({ last_run_at: new Date("2026-06-04T08:00:00.000Z") })], NOW);
  assert.equal(out[0].stale, true);
});

test("summarizeStatus marks a fresh source not stale", () => {
  const out = summarizeStatus([row({ last_run_at: new Date("2026-06-04T11:55:00.000Z") })], NOW);
  assert.equal(out[0].stale, false);
});

test("summarizeStatus carries ok/counts/error/worker/source through", () => {
  const out = summarizeStatus(
    [row({ ok: false, error: "invalid token", counts: { documents: 0, chunks: 0 } })],
    NOW,
  );
  assert.equal(out[0].ok, false);
  assert.equal(out[0].error, "invalid token");
  assert.deepEqual(out[0].counts, { documents: 0, chunks: 0 });
  assert.equal(out[0].worker, "indexer");
  assert.equal(out[0].source, "notion-personal");
});

test("summarizeStatus: a failing source is flagged stale-or-failing even when fresh", () => {
  // ok:false but only 60s old: not stale by age, but the alert path keys off ok===false.
  const out = summarizeStatus([row({ ok: false, error: "boom" })], NOW);
  assert.equal(out[0].stale, false); // age is fine
  assert.equal(out[0].ok, false); // but it failed — alert reads ok===false OR stale
});

test("summarizeStatus exposes last_run_at as ISO and preserves sync_last_at", () => {
  const lastRun = new Date("2026-06-04T11:00:00.000Z");
  const syncAt = new Date("2026-06-04T10:30:00.000Z");
  const out = summarizeStatus([row({ last_run_at: lastRun, sync_last_at: syncAt })], NOW);
  assert.equal(out[0].last_run_at, lastRun.toISOString());
  assert.equal(out[0].sync_last_at, syncAt.toISOString());
});

test("summarizeStatus handles null sync_last_at", () => {
  const out = summarizeStatus([row({ sync_last_at: null })], NOW);
  assert.equal(out[0].sync_last_at, null);
});

test("summarizeStatus maps every row (preserves order)", () => {
  const rows = [
    row({ source: "notion-personal" }),
    row({ source: "granola-personal" }),
    row({ source: "calendar" }),
  ];
  const out = summarizeStatus(rows, NOW);
  assert.deepEqual(
    out.map((r) => r.source),
    ["notion-personal", "granola-personal", "calendar"],
  );
});

test("summarizeStatus: age never negative if last_run_at is slightly in the future (clock skew)", () => {
  const out = summarizeStatus([row({ last_run_at: new Date("2026-06-04T12:00:05.000Z") })], NOW);
  assert.ok(out[0].age_seconds >= 0);
});
