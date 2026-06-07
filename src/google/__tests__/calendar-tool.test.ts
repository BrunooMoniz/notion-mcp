// src/google/__tests__/calendar-tool.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCalendarTools } from "../calendar-tool.js";

function fakeServer() {
  const tools = new Map<string, (args: any) => Promise<any>>();
  const server = { tool: (name: string, _d: string, _s: any, h: any) => tools.set(name, h) };
  return { server: server as any, tools };
}

test("registra as 5 tools de calendário", () => {
  const { server, tools } = fakeServer();
  registerCalendarTools(server);
  assert.deepEqual(
    [...tools.keys()].sort(),
    ["create_calendar_event", "delete_calendar_event", "list_calendars", "list_events", "update_calendar_event"],
  );
});

test("delete_calendar_event sem confirm não chama a rede e exige confirmação", async () => {
  const { server, tools } = fakeServer();
  registerCalendarTools(server);
  const res = await tools.get("delete_calendar_event")!({ calendar_ref: "x", event_id: "y", confirm: false });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "confirm_required");
});
