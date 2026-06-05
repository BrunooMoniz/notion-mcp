// src/rag/__tests__/status-html.test.ts
// F2.5: pure-logic tests for the /status HTML mini-dashboard. No DB, no I/O —
// renderStatusHtml / escapeHtml / humanizeAge are pure and run without POSTGRES.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderStatusHtml,
  escapeHtml,
  humanizeAge,
  type StatusSource,
} from "../status.js";

function src(over: Partial<StatusSource>): StatusSource {
  return {
    worker: "indexer",
    source: "notion-personal",
    ok: true,
    last_run_at: "2026-06-05T00:00:00.000Z",
    sync_last_at: null,
    age_seconds: 120,
    stale: false,
    counts: { documents: 10, chunks: 42 },
    error: null,
    ...over,
  };
}

// --- escapeHtml --------------------------------------------------------------

test("escapeHtml neutralizes all 5 significant chars", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("escapeHtml leaves plain text untouched", () => {
  assert.equal(escapeHtml("notion-personal"), "notion-personal");
});

// --- humanizeAge -------------------------------------------------------------

test("humanizeAge: seconds / minutes / hours / days", () => {
  assert.equal(humanizeAge(45), "45s");
  assert.equal(humanizeAge(90), "1m");
  assert.equal(humanizeAge(3 * 3600), "3h");
  assert.equal(humanizeAge(3 * 3600 + 120), "3h 2m");
  assert.equal(humanizeAge(25 * 3600), "1d 1h");
});

test("humanizeAge: boundaries 60/3600/86400 are exact", () => {
  assert.equal(humanizeAge(60), "1m");
  assert.equal(humanizeAge(3600), "1h");
  assert.equal(humanizeAge(86400), "1d");
});

test("humanizeAge: negative / NaN / fractional are guarded (C4)", () => {
  assert.equal(humanizeAge(-5), "0s");
  assert.equal(humanizeAge(NaN), "0s");
  assert.equal(humanizeAge(Infinity), "0s");
  assert.equal(humanizeAge(45.9), "45s"); // floored, no fraction leak
});

// --- renderStatusHtml --------------------------------------------------------

test("renderStatusHtml: healthy sources -> green banner, no problem state", () => {
  const html = renderStatusHtml("2026-06-05T00:00:00.000Z", [src({})]);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Todas as fontes saudáveis/);
  assert.match(html, /notion-personal/);
  assert.match(html, /class="good"/);
  assert.doesNotMatch(html, /com problema/);
});

test("renderStatusHtml: a failing source surfaces in the banner and a fail row", () => {
  const html = renderStatusHtml("2026-06-05T00:00:00.000Z", [
    src({ source: "notion-nora", ok: false, error: "invalid_token" }),
  ]);
  assert.match(html, /com problema/);
  assert.match(html, /notion-nora/);
  assert.match(html, /class="fail"/);
  assert.match(html, /FALHA/);
  assert.match(html, /invalid_token/);
});

test("renderStatusHtml: a stale (but ok) source is flagged PARADA", () => {
  const html = renderStatusHtml("2026-06-05T00:00:00.000Z", [
    src({ source: "granola-personal", stale: true }),
  ]);
  assert.match(html, /class="stale"/);
  assert.match(html, /PARADA/);
});

test("renderStatusHtml: source name with markup is escaped (no injection)", () => {
  const html = renderStatusHtml("2026-06-05T00:00:00.000Z", [
    src({ source: "<script>alert(1)</script>" }),
  ]);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderStatusHtml: empty source list still renders a valid page", () => {
  const html = renderStatusHtml("2026-06-05T00:00:00.000Z", []);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Sem runs registrados ainda/);
});
