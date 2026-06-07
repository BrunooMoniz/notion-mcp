// src/google/__tests__/friend-instructions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRIEND_INSTRUCTIONS } from "../../mcp-account-config.js";

test("FRIEND_INSTRUCTIONS cita as tools de calendário", () => {
  assert.ok(FRIEND_INSTRUCTIONS.includes("list_calendars"));
  assert.ok(FRIEND_INSTRUCTIONS.includes("create_calendar_event"));
  assert.ok(FRIEND_INSTRUCTIONS.includes("delete_calendar_event"));
});

test("FRIEND_INSTRUCTIONS continua sem vazar workspaces do Bruno", () => {
  for (const term of ["globalcripto", "nora", "Jean", "Luigi", "Victor"]) {
    assert.ok(!FRIEND_INSTRUCTIONS.includes(term));
  }
  assert.ok(!/\bpersonal\b/i.test(FRIEND_INSTRUCTIONS));
});
