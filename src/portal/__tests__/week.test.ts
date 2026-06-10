// src/portal/__tests__/week.test.ts
// GET /portal/week core — 7-day brain summary. Counts distinct documents per
// source, meetings = the granola slice, recent ≤6 newest-first with the title
// recovered from the chunk's provenance header. Account-scoped: A never sees B.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __setPoolForTest } from "../../rag/storage.js";
import { getWeekSummary } from "../week.js";

interface ChunkRow {
  account_id: string;
  source_id: string;
  source_type: string;
  chunk_index: number;
  text: string;
  indexed_at: Date;
}

let chunks: ChunkRow[];
const NOW = Date.now();
const DAY = 24 * 60 * 60_000;

function inWindow(r: ChunkRow, days: number): boolean {
  return r.indexed_at.getTime() >= NOW - days * DAY;
}

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      // Per-source distinct document counts in the window
      if (/COUNT\(DISTINCT source_id\)/i.test(sql) && /FROM brain_chunks/i.test(sql)) {
        const accountId = params[0];
        const days = Number(params[1]);
        const bySource = new Map<string, Set<string>>();
        for (const r of chunks) {
          if (r.account_id !== accountId || !inWindow(r, days)) continue;
          if (!bySource.has(r.source_type)) bySource.set(r.source_type, new Set());
          bySource.get(r.source_type)!.add(r.source_id);
        }
        const rows = [...bySource.entries()]
          .map(([source_type, ids]) => ({ source_type, count: String(ids.size) }))
          .sort((a, b) => Number(b.count) - Number(a.count));
        return { rows };
      }
      // Recent documents (one per source_id, newest first, limited)
      if (/DISTINCT ON \(source_id\)/i.test(sql) && /FROM brain_chunks/i.test(sql)) {
        const accountId = params[0];
        const days = Number(params[1]);
        const limit = Number(params[2]);
        const firstBySource = new Map<string, ChunkRow>();
        for (const r of chunks) {
          if (r.account_id !== accountId || !inWindow(r, days)) continue;
          const prev = firstBySource.get(r.source_id);
          if (!prev || r.chunk_index < prev.chunk_index) firstBySource.set(r.source_id, r);
        }
        const rows = [...firstBySource.values()]
          .sort((a, b) => b.indexed_at.getTime() - a.indexed_at.getTime())
          .slice(0, limit)
          .map((r) => ({
            source_type: r.source_type,
            first_line: r.text.split("\n")[0],
            indexed_at: r.indexed_at,
          }));
        return { rows };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  chunks = [];
  __setPoolForTest(memPool() as never);
});
afterEach(() => __setPoolForTest(null));

function seed(
  accountId: string,
  sourceId: string,
  sourceType: string,
  title: string,
  ageDays: number,
  chunkIndex = 0,
) {
  chunks.push({
    account_id: accountId,
    source_id: sourceId,
    source_type: sourceType,
    chunk_index: chunkIndex,
    text: `[DB · personal · 2026-06-08] ${title}\n\ncorpo do chunk`,
    indexed_at: new Date(NOW - ageDays * DAY),
  });
}

test("counts distinct documents and granola meetings inside the 7-day window", async () => {
  seed("acct-a", "n1", "notion", "Nota 1", 1);
  seed("acct-a", "n1", "notion", "Nota 1", 1, 1); // 2nd chunk of same doc — not double-counted
  seed("acct-a", "n2", "notion", "Nota 2", 2);
  seed("acct-a", "g1", "granola", "Reunião X", 3);
  seed("acct-a", "old", "notion", "Antiga", 10); // outside the window

  const week = await getWeekSummary("acct-a");
  assert.equal(week.documents, 3);
  assert.equal(week.meetings, 1);
  assert.deepEqual(
    week.by_source.find((s) => s.source_type === "notion"),
    { source_type: "notion", count: 2 },
  );
});

test("recent lists newest-first, caps at 6, and strips the provenance header from the title", async () => {
  for (let i = 0; i < 8; i++) seed("acct-a", `d${i}`, "notion", `Doc ${i}`, i * 0.5);

  const week = await getWeekSummary("acct-a");
  assert.equal(week.recent.length, 6);
  assert.equal(week.recent[0].title, "Doc 0"); // newest first, header stripped
  assert.equal(week.recent[0].source_type, "notion");
  assert.ok(week.recent[0].indexed_at); // ISO string present
});

test("isolation: account A's week never includes account B's documents", async () => {
  seed("acct-a", "a1", "notion", "Doc de A", 1);
  seed("acct-b", "b1", "granola", "Reunião de B", 1);

  const weekA = await getWeekSummary("acct-a");
  assert.equal(weekA.documents, 1);
  assert.equal(weekA.meetings, 0);
  assert.ok(!weekA.recent.some((r) => r.title === "Reunião de B"));

  const weekB = await getWeekSummary("acct-b");
  assert.equal(weekB.documents, 1);
  assert.equal(weekB.meetings, 1);
});

test("empty brain yields zeros and empty lists", async () => {
  const week = await getWeekSummary("acct-a");
  assert.deepEqual(week, { documents: 0, meetings: 0, by_source: [], recent: [] });
});
