// src/google/__tests__/calendar-ref.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCalendarRef, decodeCalendarRef } from "../calendar-ref.js";

test("round-trip de email + calendarId", () => {
  const ref = encodeCalendarRef("bruno@gmail.com", "abc@group.calendar.google.com");
  assert.deepEqual(decodeCalendarRef(ref), {
    email: "bruno@gmail.com",
    calendarId: "abc@group.calendar.google.com",
  });
});

test("ref opaco não é o texto cru (base64url)", () => {
  const ref = encodeCalendarRef("a@b.com", "primary");
  assert.ok(!ref.includes("@"));
  assert.match(ref, /^[A-Za-z0-9_-]+$/);
});

test("ref malformado lança", () => {
  assert.throws(() => decodeCalendarRef("não-base64-válido!!!"));
  assert.throws(() => decodeCalendarRef(Buffer.from('{"x":1}', "utf8").toString("base64url")));
});
