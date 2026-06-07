// src/google/__tests__/event-payload.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEventPayload, buildEventPatch } from "../event-payload.js";

test("evento com horário (dateTime), sem timezone", () => {
  const b = buildEventPayload({
    summary: "Call Victor",
    start: "2026-06-09T15:00:00-03:00",
    end: "2026-06-09T16:00:00-03:00",
  }) as any;
  assert.equal(b.summary, "Call Victor");
  assert.deepEqual(b.start, { dateTime: "2026-06-09T15:00:00-03:00" });
  assert.deepEqual(b.end, { dateTime: "2026-06-09T16:00:00-03:00" });
});

test("evento com timezone explícito", () => {
  const b = buildEventPayload({
    summary: "X",
    start: "2026-06-09T15:00:00",
    end: "2026-06-09T16:00:00",
    timezone: "America/Sao_Paulo",
  }) as any;
  assert.deepEqual(b.start, { dateTime: "2026-06-09T15:00:00", timeZone: "America/Sao_Paulo" });
});

test("evento de dia inteiro (date)", () => {
  const b = buildEventPayload({ summary: "Feriado", start: "2026-06-09", end: "2026-06-10", all_day: true }) as any;
  assert.deepEqual(b.start, { date: "2026-06-09" });
  assert.deepEqual(b.end, { date: "2026-06-10" });
});

test("descrição, local e convidados", () => {
  const b = buildEventPayload({
    summary: "X",
    start: "2026-06-09T15:00:00",
    end: "2026-06-09T16:00:00",
    description: "pauta",
    location: "Meet",
    attendees: ["a@x.com", "b@y.com"],
  }) as any;
  assert.equal(b.description, "pauta");
  assert.equal(b.location, "Meet");
  assert.deepEqual(b.attendees, [{ email: "a@x.com" }, { email: "b@y.com" }]);
});

test("patch só inclui campos passados", () => {
  const p = buildEventPatch({ summary: "Novo título" }) as any;
  assert.deepEqual(p, { summary: "Novo título" });
  const p2 = buildEventPatch({ start: "2026-06-09T18:00:00", timezone: "America/Sao_Paulo" }) as any;
  assert.deepEqual(p2.start, { dateTime: "2026-06-09T18:00:00", timeZone: "America/Sao_Paulo" });
  assert.equal(p2.summary, undefined);
});
