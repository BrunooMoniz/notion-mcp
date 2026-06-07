// src/google/__tests__/calendar-client.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createEvent, updateEvent, deleteEvent, listCalendarsWithToken } from "../calendar.js";

const realFetch = globalThis.fetch;
let last: { url: string; init: any };
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  last = { url: "", init: {} };
  globalThis.fetch = (async (url: any, init: any) => {
    last = { url: String(url), init };
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (String(url).includes("calendarList")) return new Response(JSON.stringify({ items: [{ id: "primary", primary: true }] }), { status: 200 });
    return new Response(JSON.stringify({ id: "evt-1", htmlLink: "https://cal/evt-1" }), { status: 200 });
  }) as typeof fetch;
});

test("createEvent: POST para /calendars/{id}/events com Bearer e JSON", async () => {
  const ev = await createEvent("tok", "a@b.com", { summary: "X" });
  assert.equal(ev.id, "evt-1");
  assert.match(last.url, /\/calendars\/a%40b\.com\/events$/);
  assert.equal(last.init.method, "POST");
  assert.equal(last.init.headers.Authorization, "Bearer tok");
  assert.match(last.init.headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(last.init.body), { summary: "X" });
});

test("updateEvent: PATCH para /events/{eventId}", async () => {
  await updateEvent("tok", "primary", "evt-9", { summary: "Novo" });
  assert.match(last.url, /\/calendars\/primary\/events\/evt-9$/);
  assert.equal(last.init.method, "PATCH");
  assert.deepEqual(JSON.parse(last.init.body), { summary: "Novo" });
});

test("deleteEvent: DELETE para /events/{eventId}", async () => {
  await deleteEvent("tok", "primary", "evt-9");
  assert.match(last.url, /\/calendars\/primary\/events\/evt-9$/);
  assert.equal(last.init.method, "DELETE");
});

test("listCalendarsWithToken usa o token passado", async () => {
  const cals = await listCalendarsWithToken("tok");
  assert.equal(cals[0].id, "primary");
  assert.equal(last.init.headers.Authorization, "Bearer tok");
});
