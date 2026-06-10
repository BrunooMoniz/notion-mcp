// src/rag/__tests__/daily-briefing.test.ts
// Unit tests for the daily-briefing worker. Covers the PURE/mockable parts:
//   - today-event date filtering (given DB rows, picks today's, dedupes)
//   - prompt/markdown assembly (mock callHaiku to echo; assert prompt content)
// No live DB / Notion / Anthropic — deps are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getTodayEvents,
  gatherContext,
  buildBriefingMarkdown,
  buildBriefingPrompt,
  type BriefingEvent,
  type EventContext,
  type BriefingTask,
} from "../../briefing/daily-briefing.js";
import type { brainSearch } from "../search.js";

// A minimal pool stub: captures the SQL + params and returns canned rows.
function fakePool(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    pool: {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      },
    } as any,
    calls,
  };
}

const NOW = new Date("2026-06-04T09:00:00-03:00");

test("getTodayEvents filters to current date via SQL param and maps rows", async () => {
  const { pool, calls } = fakePool([
    {
      source_id: "evt-1",
      title: "Sync com Parfin",
      data: "2026-06-04",
      calendar_label: "Global Cripto",
      attendees: ["Jorge", "Ana"],
    },
    {
      source_id: "evt-2",
      title: "1:1 Jean",
      data: "2026-06-04T15:00:00-03:00",
      calendar_label: "Nora",
      attendees: ["Jean"],
    },
  ]);

  const events = await getTodayEvents(pool, NOW);

  // SQL targets calendar source_type and uses the date param.
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /source_type/);
  assert.match(calls[0].sql, /calendar/);
  assert.match(calls[0].sql, /metadata->>'data'/);
  // The current-date param is threaded in (YYYY-MM-DD of NOW, local).
  assert.ok(calls[0].params.includes("2026-06-04"));

  assert.equal(events.length, 2);
  assert.equal(events[0].title, "Sync com Parfin");
  assert.equal(events[0].calendar, "Global Cripto");
  assert.deepEqual(events[0].attendees, ["Jorge", "Ana"]);
  assert.equal(events[1].title, "1:1 Jean");
});

test("getTodayEvents dedupes by source_id (keeps first occurrence)", async () => {
  const { pool } = fakePool([
    { source_id: "evt-1", title: "Reunião A", data: "2026-06-04", calendar_label: "Pessoal", attendees: [] },
    { source_id: "evt-1", title: "Reunião A", data: "2026-06-04", calendar_label: "Pessoal", attendees: [] },
    { source_id: "evt-2", title: "Reunião B", data: "2026-06-04", calendar_label: "Pessoal", attendees: [] },
  ]);
  const events = await getTodayEvents(pool, NOW);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.title), ["Reunião A", "Reunião B"]);
});

test("getTodayEvents handles empty/missing attendees gracefully", async () => {
  const { pool } = fakePool([
    { source_id: "evt-1", title: "Foco", data: "2026-06-04", calendar_label: null, attendees: null },
  ]);
  const events = await getTodayEvents(pool, NOW);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].attendees, []);
  assert.equal(events[0].calendar, "");
});

// --- gatherContext ----------------------------------------------------------

test("gatherContext searches per event with logEvent:false (internal — stays out of ai_search_log)", async () => {
  const calls: { query: string; opts: any }[] = [];
  const fakeSearch = (async (query: string, opts: any) => {
    calls.push({ query, opts });
    return [];
  }) as unknown as typeof brainSearch;

  const events: BriefingEvent[] = [
    { title: "Sync com Parfin", time: "10:00", calendar: "Global Cripto", attendees: ["Jorge"] },
  ];
  const out = await gatherContext(events, [], fakeSearch);

  assert.equal(out.length, 1);
  assert.equal(calls.length, 1);
  // Query carries title + attendees (the PII reason these must not be logged).
  assert.equal(calls[0].query, "Sync com Parfin Jorge");
  assert.equal(calls[0].opts.logEvent, false);
  assert.equal(calls[0].opts.filters.exclude_source_type, "calendar");
});

// --- prompt assembly -------------------------------------------------------

const EVENTS: BriefingEvent[] = [
  { title: "Sync com Parfin", time: "10:00", calendar: "Global Cripto", attendees: ["Jorge"] },
  { title: "1:1 Jean", time: "15:00", calendar: "Nora", attendees: ["Jean"] },
];

const CONTEXTS: EventContext[] = [
  {
    eventTitle: "Sync com Parfin",
    items: [
      { title: "Reunião Parfin custódia", url: "https://notion.so/parfin1", snippet: "Definimos SLA de settlement" },
    ],
  },
  { eventTitle: "1:1 Jean", items: [] },
];

const TASKS: BriefingTask[] = [
  { name: "Revisar minuta BRS", priority: "Ultra", due: "2026-06-03", tempo_estimado: 60 },
  { name: "Aprovar deploy Firebit", priority: "High", due: "2026-06-04", tempo_estimado: 30 },
];

test("buildBriefingPrompt includes events, contexts, tasks and section instructions", () => {
  const prompt = buildBriefingPrompt(EVENTS, CONTEXTS, TASKS, NOW);

  // Events present
  assert.match(prompt, /Sync com Parfin/);
  assert.match(prompt, /1:1 Jean/);
  assert.match(prompt, /Jorge/);
  // Context snippet present
  assert.match(prompt, /Reunião Parfin custódia/);
  assert.match(prompt, /SLA de settlement/);
  // Tasks present
  assert.match(prompt, /Revisar minuta BRS/);
  assert.match(prompt, /Aprovar deploy Firebit/);
  assert.match(prompt, /Ultra/);
  // Section headers the model must produce
  assert.match(prompt, /Agenda de hoje/);
  assert.match(prompt, /Foco do dia/);
  assert.match(prompt, /Loops abertos/);
});

test("buildBriefingPrompt still asks for Foco/Loops when there are no events", () => {
  const prompt = buildBriefingPrompt([], [], TASKS, NOW);
  assert.match(prompt, /Foco do dia/);
  assert.match(prompt, /Loops abertos/);
  // Tasks still present so the model can build Foco even with no agenda.
  assert.match(prompt, /Revisar minuta BRS/);
});

test("buildBriefingMarkdown calls the injected synth and returns its markdown", async () => {
  let receivedSystem = "";
  let receivedUser = "";
  const fakeSynth = async (system: string, user: string) => {
    receivedSystem = system;
    receivedUser = user;
    return "## Agenda de hoje\n- algo";
  };

  const md = await buildBriefingMarkdown(EVENTS, CONTEXTS, TASKS, NOW, fakeSynth);

  assert.equal(md, "## Agenda de hoje\n- algo");
  // System prompt is PT-BR briefing role.
  assert.match(receivedSystem, /briefing|PT-BR|português|portugues/i);
  // The user prompt is the assembled prompt (carries the events/tasks).
  assert.match(receivedUser, /Sync com Parfin/);
  assert.match(receivedUser, /Revisar minuta BRS/);
});
