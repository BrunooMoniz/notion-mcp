// src/portal/__tests__/next-meeting.test.ts
// GET /portal/next-meeting core — robust event-start parsing across the three
// calendar metadata shapes (iCal full ISO, gcal-oauth date-only + "Quando:"
// line, all-day date-only) and the picker: timed events strictly future,
// all-day events kept while their day is today or later (all_day flag + bare
// YYYY-MM-DD starts_at). Account scoping is enforced at the SQL layer
// (getNextMeeting passes the session account).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __setPoolForTest } from "../../rag/storage.js";
import {
  parseEventStart,
  pickNextMeeting,
  getNextMeeting,
  type CalendarEventRow,
} from "../next-meeting.js";

const NOW = new Date("2026-06-10T12:00:00Z");

function row(over: Partial<CalendarEventRow> & { metadata?: Record<string, unknown> }): CalendarEventRow {
  return {
    first_line: over.first_line ?? "[Calendar · personal · 2026-06-11] Evento",
    text: over.text ?? "[Calendar · personal · 2026-06-11] Evento\n\n# Evento",
    db_name: over.db_name ?? null,
    metadata: over.metadata ?? null,
  };
}

// --- parseEventStart ---

test("parseEventStart: full ISO timestamp in metadata.data (iCal timed event)", () => {
  const p = parseEventStart(row({ metadata: { data: "2026-06-11T14:30:00.000Z" } }));
  assert.equal(p?.start.toISOString(), "2026-06-11T14:30:00.000Z");
  assert.equal(p?.allDay, false);
});

test("parseEventStart: date-only metadata falls back to the text's Quando line (gcal-oauth)", () => {
  const p = parseEventStart(
    row({
      metadata: { data: "2026-06-11" },
      text: "[Calendar] Evento\n\n# Evento\n**Quando:** 2026-06-11T09:00:00-03:00\n**Calendário:** Trabalho",
    }),
  );
  assert.equal(p?.start.toISOString(), "2026-06-11T12:00:00.000Z");
  assert.equal(p?.allDay, false);
});

test("parseEventStart: all-day event (date-only, no Quando time) is flagged allDay", () => {
  const p = parseEventStart(row({ metadata: { data: "2026-06-12" }, text: "# Evento\n**Quando:** 2026-06-12" }));
  assert.ok(p);
  assert.equal(p!.allDay, true);
  assert.equal(p!.start.getFullYear(), 2026);
  assert.equal(p!.start.getMonth(), 5);
  assert.equal(p!.start.getDate(), 12);
});

test("parseEventStart: garbage/missing dates return null", () => {
  assert.equal(parseEventStart(row({ metadata: { data: "not a date" } })), null);
  assert.equal(parseEventStart(row({ metadata: {} })), null);
  assert.equal(parseEventStart(row({ metadata: null as never })), null);
});

// --- pickNextMeeting ---

test("pickNextMeeting picks the EARLIEST future event and skips past ones", () => {
  const result = pickNextMeeting(
    [
      row({ first_line: "[Cal] Ontem", metadata: { data: "2026-06-09T10:00:00Z" } }),
      row({ first_line: "[Cal] Depois", metadata: { data: "2026-06-13T10:00:00Z" } }),
      row({ first_line: "[Cal] Próxima", metadata: { data: "2026-06-11T10:00:00Z" } }),
    ],
    NOW,
  );
  assert.equal(result.found, true);
  assert.equal(result.title, "Próxima");
  assert.equal(result.starts_at, "2026-06-11T10:00:00.000Z");
  assert.equal(result.all_day, false);
});

test("pickNextMeeting INCLUDES today's all-day event (date >= today, not strictly future)", () => {
  // NOW is mid-day: a timed event earlier today is past, but today's all-day
  // event must still show (it lasts all day).
  const today = new Date(NOW.getTime());
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const result = pickNextMeeting(
    [row({ first_line: "[Cal] Feriado", metadata: { data: todayStr }, text: "# Feriado" })],
    NOW,
  );
  assert.equal(result.found, true);
  assert.equal(result.title, "Feriado");
  assert.equal(result.all_day, true);
  // All-day: starts_at is the bare YYYY-MM-DD, never a fabricated midnight ISO.
  assert.equal(result.starts_at, todayStr);
});

test("pickNextMeeting still skips YESTERDAY's all-day event and past timed events", () => {
  const result = pickNextMeeting(
    [
      row({ metadata: { data: "2026-06-09" }, text: "# Ontem dia todo" }), // all-day yesterday
      row({ metadata: { data: "2026-06-10T08:00:00Z" } }), // timed earlier today
    ],
    NOW,
  );
  assert.deepEqual(result, { found: false });
});

test("pickNextMeeting: future all-day event returns the bare date + all_day flag", () => {
  const result = pickNextMeeting(
    [row({ first_line: "[Cal] Viagem", metadata: { data: "2026-06-12" }, text: "# Viagem" })],
    NOW,
  );
  assert.equal(result.found, true);
  assert.equal(result.all_day, true);
  assert.equal(result.starts_at, "2026-06-12");
});

test("pickNextMeeting extracts calendar (calendar_label, db_name fallback) and attendees", () => {
  const withLabel = pickNextMeeting(
    [
      row({
        metadata: {
          data: "2026-06-11T10:00:00Z",
          calendar_label: "Trabalho",
          attendees: ["Ana", "Bruno", 42], // non-strings dropped
        },
      }),
    ],
    NOW,
  );
  assert.equal(withLabel.calendar, "Trabalho");
  assert.deepEqual(withLabel.attendees, ["Ana", "Bruno"]);

  const withDbName = pickNextMeeting(
    [row({ db_name: "Agenda pessoal", metadata: { data: "2026-06-11T10:00:00Z" } })],
    NOW,
  );
  assert.equal(withDbName.calendar, "Agenda pessoal");
});

test("pickNextMeeting returns {found:false} when nothing is in the future", () => {
  const result = pickNextMeeting(
    [row({ metadata: { data: "2026-06-01T10:00:00Z" } }), row({ metadata: { data: "garbage" } })],
    NOW,
  );
  assert.deepEqual(result, { found: false });
});

// --- getNextMeeting (SQL scoping + candidate ordering) ---

test("getNextMeeting queries calendar chunks scoped to the given account only", async () => {
  const captured: { sql: string; params: any[] }[] = [];
  __setPoolForTest({
    query: async (sql: string, params: any[]) => {
      captured.push({ sql, params });
      return { rows: [] };
    },
  } as never);
  try {
    const result = await getNextMeeting("acct-a", NOW);
    assert.deepEqual(result, { found: false });
    assert.equal(captured.length, 1);
    assert.match(captured[0].sql, /source_type = 'calendar'/);
    assert.equal(captured[0].params[0], "acct-a"); // account pinned in WHERE
    assert.equal(captured[0].params[1], "2026-06-10"); // coarse date prefix filter
  } finally {
    __setPoolForTest(null);
  }
});

test("getNextMeeting orders candidates chronologically BEFORE the LIMIT (soonest 500 win)", async () => {
  let sql = "";
  __setPoolForTest({
    query: async (q: string) => {
      sql = q;
      return { rows: [] };
    },
  } as never);
  try {
    await getNextMeeting("acct-a", NOW);
    // Outer query: ORDER BY the event date (lexicographic = chronological for
    // ISO / YYYY-MM-DD) and only then LIMIT — never an unordered slice.
    assert.match(sql, /ORDER BY d\.metadata->>'data'\s+LIMIT 500/);
  } finally {
    __setPoolForTest(null);
  }
});

afterEach(() => __setPoolForTest(null));
