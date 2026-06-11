// src/tasks/__tests__/plan-context.test.ts
// 003-tasks-v1 — free slots (sobreposição, all-day, fins de semana, timezone),
// dedup de eventos, agrupamento de tarefas e validação de janela. Tudo puro.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeFreeSlots,
  dedupPlanEvents,
  groupOpenTasks,
  validatePlanWindow,
  isValidTimezone,
  zonedTimeToUtc,
  localDateInTz,
  isoInTz,
  stripBracketPrefix,
  listDates,
  weekdayOf,
  PLAN_GUIDANCE,
  type PlanEvent,
} from "../plan-context.js";
import { dedupBriefingEvents } from "../../rag/brain-today-tool.js";
import type { Task } from "../model.js";

const SP = "America/Sao_Paulo"; // UTC-3, sem DST atualmente

const baseOpts = {
  period_start: "2026-06-10", // quarta
  period_end: "2026-06-10",
  timezone: SP,
  work_start: "09:00",
  work_end: "19:00",
  include_weekends: false,
};

const ev = (over: Partial<PlanEvent>): PlanEvent => ({
  title: "Evento",
  start: "2026-06-10T10:00:00-03:00",
  end: "2026-06-10T11:00:00-03:00",
  all_day: false,
  calendar: "Pessoal",
  ...over,
});

// --- computeFreeSlots ----------------------------------------------------------------

test("free slots: dia sem eventos = janela de trabalho inteira", () => {
  const days = computeFreeSlots([], baseOpts);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].free, [{ start: "09:00", end: "19:00", min: 600 }]);
  assert.equal(days[0].free_min, 600);
});

test("free slots: evento timed quebra a janela", () => {
  const days = computeFreeSlots([ev({})], baseOpts);
  assert.deepEqual(days[0].free, [
    { start: "09:00", end: "10:00", min: 60 },
    { start: "11:00", end: "19:00", min: 480 },
  ]);
  assert.equal(days[0].free_min, 540);
});

test("free slots: eventos sobrepostos são fundidos", () => {
  const days = computeFreeSlots(
    [
      ev({ start: "2026-06-10T10:00:00-03:00", end: "2026-06-10T11:00:00-03:00" }),
      ev({ start: "2026-06-10T10:30:00-03:00", end: "2026-06-10T12:00:00-03:00" }),
      ev({ start: "2026-06-10T11:00:00-03:00", end: "2026-06-10T11:30:00-03:00" }), // contido
    ],
    baseOpts,
  );
  assert.deepEqual(days[0].free, [
    { start: "09:00", end: "10:00", min: 60 },
    { start: "12:00", end: "19:00", min: 420 },
  ]);
});

test("free slots: all-day NÃO bloqueia", () => {
  const days = computeFreeSlots(
    [ev({ start: "2026-06-10", end: null, all_day: true })],
    baseOpts,
  );
  assert.deepEqual(days[0].free, [{ start: "09:00", end: "19:00", min: 600 }]);
});

test("free slots: evento sem fim bloqueia 60 min", () => {
  const days = computeFreeSlots([ev({ end: null })], baseOpts);
  assert.deepEqual(days[0].free, [
    { start: "09:00", end: "10:00", min: 60 },
    { start: "11:00", end: "19:00", min: 480 },
  ]);
});

test("free slots: fim de semana fora por default; include_weekends inclui", () => {
  const opts = { ...baseOpts, period_start: "2026-06-08", period_end: "2026-06-14" }; // seg→dom
  const weekdays = computeFreeSlots([], opts);
  assert.deepEqual(
    weekdays.map((d) => d.date),
    ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"],
  );
  const all = computeFreeSlots([], { ...opts, include_weekends: true });
  assert.equal(all.length, 7);
});

test("free slots: timezone muda o recorte (mesmo instante, janelas locais diferentes)", () => {
  // 12:00Z = 09:00 em SP. Em UTC o evento bloqueia 12-13; em SP bloqueia 09-10.
  const e = ev({ start: "2026-06-10T12:00:00Z", end: "2026-06-10T13:00:00Z" });
  const utc = computeFreeSlots([e], { ...baseOpts, timezone: "UTC" });
  assert.deepEqual(utc[0].free, [
    { start: "09:00", end: "12:00", min: 180 },
    { start: "13:00", end: "19:00", min: 360 },
  ]);
  const sp = computeFreeSlots([e], baseOpts);
  assert.deepEqual(sp[0].free, [{ start: "10:00", end: "19:00", min: 540 }]);
});

test("zonedTimeToUtc: 09:00 em SP = 12:00Z", () => {
  assert.equal(zonedTimeToUtc("2026-06-10", "09:00", SP).toISOString(), "2026-06-10T12:00:00.000Z");
});

test("localDateInTz: 00:30Z ainda é o dia ANTERIOR em BRT", () => {
  const instant = new Date("2026-06-11T00:30:00Z"); // 21:30 de 06-10 em SP
  assert.equal(localDateInTz(SP, instant), "2026-06-10");
  assert.equal(localDateInTz("UTC", instant), "2026-06-11");
});

test("isoInTz: instante UTC re-expresso no offset do tz", () => {
  assert.equal(isoInTz(new Date("2026-06-16T01:00:00Z"), SP), "2026-06-15T22:00:00-03:00");
  assert.equal(isoInTz(new Date("2026-06-15T12:00:00Z"), "UTC"), "2026-06-15T12:00:00+00:00");
});

test("stripBracketPrefix: remove o header de colchetes do índice", () => {
  assert.equal(stripBracketPrefix("[Calendar · personal · 2026-06-15] Reunião X"), "Reunião X");
  assert.equal(stripBracketPrefix("Reunião X"), "Reunião X");
});

test("listDates/weekdayOf: janela inclusiva e dia da semana", () => {
  assert.deepEqual(listDates("2026-06-09", "2026-06-11"), ["2026-06-09", "2026-06-10", "2026-06-11"]);
  assert.equal(weekdayOf("2026-06-13"), 6); // sábado
  assert.equal(weekdayOf("2026-06-14"), 0); // domingo
});

// --- dedup ------------------------------------------------------------------------------

test("dedupPlanEvents: título normalizado + start (acentos/caixa não duplicam)", () => {
  const out = dedupPlanEvents([
    ev({ title: "Reunião Nora", calendar: "A" }),
    ev({ title: "reuniao nora", calendar: "B" }),
    ev({ title: "Reunião Nora", start: "2026-06-10T15:00:00-03:00" }), // outro horário → fica
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].calendar, "A"); // primeira ocorrência vence
});

test("dedupPlanEvents: header de colchetes do brain não impede o dedup com o evento ao vivo", () => {
  const out = dedupPlanEvents([
    ev({ title: "Reunião X", calendar: "Google" }), // live primeiro → vence
    ev({ title: "[Calendar · personal · 2026-06-10] Reunião X", calendar: "iCal" }),
    ev({ title: "[Calendar · nora · 2026-06-10] Reunião X", calendar: "iCal nora" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].calendar, "Google");
});

test("dedupPlanEvents: mesmo instante em offsets diferentes deduplica (epoch)", () => {
  const out = dedupPlanEvents([
    ev({ start: "2026-06-10T14:00:00-03:00", calendar: "A" }),
    ev({ start: "2026-06-10T17:00:00Z", calendar: "B" }), // mesmo instante
    ev({ start: "2026-06-10T18:00:00Z", calendar: "C" }), // outro instante → fica
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].calendar, "A");
});

test("dedupBriefingEvents (brain_today): título normalizado + data + hora", () => {
  const out = dedupBriefingEvents(
    [
      { title: "Daily GC", time: "09:30", calendar: "GC", attendees: [] },
      { title: "daily gc", time: "09:30", calendar: "Pessoal", attendees: [] },
      { title: "Daily GC", time: "16:00", calendar: "GC", attendees: [] },
    ],
    "2026-06-10",
  );
  assert.equal(out.length, 2);
});

test("dedupBriefingEvents: strip do header de colchetes na chave", () => {
  const out = dedupBriefingEvents(
    [
      { title: "[Calendar · personal · 2026-06-15] Reunião X", time: "14:00", calendar: "A", attendees: [] },
      { title: "[Calendar · nora · 2026-06-15] Reunião X", time: "14:00", calendar: "B", attendees: [] },
      { title: "Reunião X", time: "14:00", calendar: "C", attendees: [] },
    ],
    "2026-06-15",
  );
  assert.equal(out.length, 1);
});

// --- groupOpenTasks ------------------------------------------------------------------------

const mkTask = (over: Partial<Task>): Task => ({
  id: "t",
  url: null,
  title: "x",
  status: "todo",
  ...over,
});

test("groupOpenTasks: ordem backlog→todo→in_progress→blocked, literal depois, overdue em destaque", () => {
  const g = groupOpenTasks(
    [
      mkTask({ id: "1", status: "todo", prazo: "2026-06-01" }), // overdue
      mkTask({ id: "2", status: "backlog" }),
      mkTask({ id: "3", status: "in_progress", tempo_estimado_min: 30 }),
      mkTask({ id: "4", status: "Em validação" }), // passthrough
    ],
    "2026-06-10",
  );
  assert.deepEqual(Object.keys(g.by_status), ["backlog", "todo", "in_progress", "Em validação"]);
  assert.equal(g.by_status["todo"][0].overdue, true);
  assert.equal(g.by_status["in_progress"][0].tempo_estimado_min, 30);
  assert.deepEqual(g.overdue.map((t) => t.id), ["1"]);
});

// --- janela / timezone / guidance --------------------------------------------------------------

test("validatePlanWindow: formato, ordem e cap de 35 dias", () => {
  assert.equal(validatePlanWindow("2026-06-01", "2026-06-30"), null);
  assert.equal(validatePlanWindow("2026-06-01", "2026-07-05"), null); // 35 dias exatos
  assert.match(validatePlanWindow("2026-06-01", "2026-07-06")!, /35 dias/);
  assert.match(validatePlanWindow("2026-06-10", "2026-06-01")!, /posterior/);
  assert.match(validatePlanWindow("10/06/2026", "2026-06-30")!, /YYYY-MM-DD/);
});

test("isValidTimezone: IANA válida vs inválida", () => {
  assert.equal(isValidTimezone("America/Sao_Paulo"), true);
  assert.equal(isValidTimezone("Marte/Olympus"), false);
});

test("guidance: 3 linhas fixas (alocar, blocktime, atualizar board)", () => {
  assert.equal(PLAN_GUIDANCE.length, 3);
  assert.match(PLAN_GUIDANCE[0], /prazo e prioridade/);
  assert.match(PLAN_GUIDANCE[1], /create_calendar_event|zinom_create_task/);
  assert.match(PLAN_GUIDANCE[2], /zinom_update_task/);
});
