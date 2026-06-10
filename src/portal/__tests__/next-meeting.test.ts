// src/portal/__tests__/next-meeting.test.ts
// GET /portal/next-meeting core — robust event-start parsing across the three
// calendar metadata shapes (iCal full ISO, gcal-oauth date-only + "Quando:"
// line, all-day date-only) and the earliest-future picker. Account scoping is
// enforced at the SQL layer (getNextMeeting passes the session account).
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
  const d = parseEventStart(row({ metadata: { data: "2026-06-11T14:30:00.000Z" } }));
  assert.equal(d?.toISOString(), "2026-06-11T14:30:00.000Z");
});

test("parseEventStart: date-only metadata falls back to the text's Quando line (gcal-oauth)", () => {
  const d = parseEventStart(
    row({
      metadata: { data: "2026-06-11" },
      text: "[Calendar] Evento\n\n# Evento\n**Quando:** 2026-06-11T09:00:00-03:00\n**Calendário:** Trabalho",
    }),
  );
  assert.equal(d?.toISOString(), "2026-06-11T12:00:00.000Z");
});

test("parseEventStart: all-day event (date-only, no Quando time) parses as midnight", () => {
  const d = parseEventStart(row({ metadata: { data: "2026-06-12" }, text: "# Evento\n**Quando:** 2026-06-12" }));
  assert.ok(d);
  assert.equal(d!.getFullYear(), 2026);
  assert.equal(d!.getMonth(), 5);
  assert.equal(d!.getDate(), 12);
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

// --- getNextMeeting (SQL scoping) ---

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

afterEach(() => __setPoolForTest(null));
