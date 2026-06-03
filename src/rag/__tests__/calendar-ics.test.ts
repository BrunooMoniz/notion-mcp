import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIcsConfig,
  icsToDocuments,
  type IcsCalendarConfig,
} from "../calendar-ics-source.js";

const CFG: IcsCalendarConfig = { url: "https://x/basic.ics", label: "Pessoal", workspace: "personal" };
const NOW = new Date("2026-06-03T12:00:00Z");

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-timed
SUMMARY:Reunião com Julia
DTSTART:20260610T140000Z
DTEND:20260610T150000Z
LOCATION:Google Meet
DESCRIPTION:<b>Pauta</b>: alinhar viagem
ORGANIZER;CN=Bruno Moniz:mailto:brunoomoniz@gmail.com
ATTENDEE;CN=Julia:mailto:julia@example.com
END:VEVENT
BEGIN:VEVENT
UID:evt-recur
SUMMARY:Pagamento CEMIG
DTSTART;VALUE=DATE:20240604
RRULE:FREQ=MONTHLY
END:VEVENT
BEGIN:VEVENT
UID:evt-cancelled
SUMMARY:Evento Cancelado
DTSTART:20260611T140000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:evt-allday
SUMMARY:Aniversário Fulano
DTSTART;VALUE=DATE:20260615
END:VEVENT
END:VCALENDAR`;

test("parseIcsConfig parses valid entries and skips malformed/bad-workspace/invalid-json", () => {
  const ok = parseIcsConfig(
    JSON.stringify([
      { url: "https://a/basic.ics", label: "Pessoal", workspace: "personal" },
      { url: "https://b/basic.ics", label: "Sem WS" }, // missing workspace -> skip
      { url: "https://c/basic.ics", label: "Bad WS", workspace: "marte" }, // invalid ws -> skip
    ]),
  );
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0], { url: "https://a/basic.ics", label: "Pessoal", workspace: "personal" });

  assert.deepEqual(parseIcsConfig("not json"), []);
  assert.deepEqual(parseIcsConfig('{"not":"array"}'), []);
  assert.deepEqual(parseIcsConfig(undefined), []);
  assert.deepEqual(parseIcsConfig(""), []);
});

test("icsToDocuments maps a timed event with attendees, stripped HTML, and workspace", () => {
  const docs = icsToDocuments(SAMPLE, CFG, NOW);
  const timed = docs.find((d) => d.source_id === "ics:Pessoal::evt-timed");
  assert.ok(timed, "timed event indexed");
  assert.equal(timed!.source_type, "calendar");
  assert.equal(timed!.workspace, "personal");
  assert.equal(timed!.db_name, "Calendar");
  assert.equal(timed!.metadata.data, "2026-06-10T14:00:00.000Z");
  assert.deepEqual(timed!.metadata.attendees, ["Julia"]);
  assert.match(timed!.text, /Reunião com Julia/);
  assert.match(timed!.text, /Pauta: alinhar viagem/); // HTML stripped
  assert.doesNotMatch(timed!.text, /<b>/);
});

test("icsToDocuments uses the NEXT occurrence date for recurring events", () => {
  const docs = icsToDocuments(SAMPLE, CFG, NOW);
  const rec = docs.find((d) => d.source_id === "ics:Pessoal::evt-recur");
  assert.ok(rec, "recurring event indexed");
  // monthly from 2024-06-04, next on/after 2026-06-03 is 2026-06-04
  assert.equal((rec!.metadata.data as string).slice(0, 10), "2026-06-04");
  assert.match(rec!.text, /\(recorrente\)/);
});

test("icsToDocuments skips cancelled events", () => {
  const docs = icsToDocuments(SAMPLE, CFG, NOW);
  assert.equal(docs.find((d) => d.source_id === "ics:Pessoal::evt-cancelled"), undefined);
});

test("icsToDocuments emits YYYY-MM-DD for all-day events", () => {
  const docs = icsToDocuments(SAMPLE, CFG, NOW);
  const allday = docs.find((d) => d.source_id === "ics:Pessoal::evt-allday");
  assert.ok(allday, "all-day event indexed");
  assert.equal(allday!.metadata.data, "2026-06-15");
});
