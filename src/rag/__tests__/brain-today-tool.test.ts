// src/rag/__tests__/brain-today-tool.test.ts
// TDD: red before implementation, green after.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBrainToday,
  type BrainTodayDeps,
  type BrainTodayResult,
} from "../brain-today-tool.js";

// ---------- minimal stubs ---------------------------------------------------

function makeDeps(overrides: Partial<BrainTodayDeps> = {}): BrainTodayDeps {
  return {
    getTodayEvents: async (_pool, _date) => [
      { title: "Sync Nora", time: "10:00", calendar: "Nora", attendees: ["Jean"] },
    ],
    gatherContext: async (_events, _tasks) => [
      { eventTitle: "Sync Nora", items: [{ title: "Nota anterior", url: "https://notion.so/x", snippet: "..." }] },
    ],
    getTopTasks: async (_limit) => [
      { name: "Tarefa A", priority: "High", due: "2026-06-04", tempo_estimado: 30 },
    ],
    getPool: () => ({} as any),
    ...overrides,
  };
}

// ---------- shape tests -----------------------------------------------------

test("buildBrainToday returns date string in YYYY-MM-DD format", async () => {
  const result = await buildBrainToday({ date: "2026-06-04" }, makeDeps());
  assert.match(result.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.date, "2026-06-04");
});

test("buildBrainToday defaults to today when date param absent", async () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const todayStr = `${y}-${m}-${d}`;
  const result = await buildBrainToday({}, makeDeps());
  assert.equal(result.date, todayStr);
});

test("buildBrainToday returns events array", async () => {
  const result = await buildBrainToday({ date: "2026-06-04" }, makeDeps());
  assert.ok(Array.isArray(result.events), "events must be an array");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, "Sync Nora");
});

test("buildBrainToday returns context array", async () => {
  const result = await buildBrainToday({ date: "2026-06-04" }, makeDeps());
  assert.ok(Array.isArray(result.context), "context must be an array");
  assert.equal(result.context.length, 1);
  assert.equal(result.context[0].eventTitle, "Sync Nora");
});

test("buildBrainToday returns tasks array", async () => {
  const result = await buildBrainToday({ date: "2026-06-04" }, makeDeps());
  assert.ok(Array.isArray(result.tasks), "tasks must be an array");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, "Tarefa A");
});

test("buildBrainToday passes the resolved date as a Date to getTodayEvents", async () => {
  const capturedDates: Date[] = [];
  const deps = makeDeps({
    getTodayEvents: async (_pool, date) => { capturedDates.push(date); return []; },
  });
  await buildBrainToday({ date: "2026-01-15" }, deps);
  assert.equal(capturedDates.length, 1);
  assert.ok(capturedDates[0] instanceof Date, "should pass a Date object");
  // The date should reflect 2026-01-15
  assert.equal(capturedDates[0].getFullYear(), 2026);
  assert.equal(capturedDates[0].getMonth(), 0); // January
  assert.equal(capturedDates[0].getDate(), 15);
});

test("buildBrainToday gatherContext receives the fetched events", async () => {
  const capturedEvents: unknown[] = [];
  const deps = makeDeps({
    getTodayEvents: async (_pool, _date) => [
      { title: "Reunião X", time: "09:00", calendar: "Cal", attendees: [] },
    ],
    gatherContext: async (events, _tasks) => { capturedEvents.push(...events); return []; },
  });
  await buildBrainToday({ date: "2026-06-04" }, deps);
  assert.equal(capturedEvents.length, 1);
  assert.equal((capturedEvents[0] as any).title, "Reunião X");
});

test("buildBrainToday returns empty events and tasks gracefully", async () => {
  const deps = makeDeps({
    getTodayEvents: async () => [],
    gatherContext: async () => [],
    getTopTasks: async () => [],
  });
  const result = await buildBrainToday({}, deps);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.context, []);
  assert.deepEqual(result.tasks, []);
});
