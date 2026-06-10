// src/rag/__tests__/oauth-registration-window.test.ts
// The registration-window state machine. Deterministic: every assertion passes
// an explicit `now`. The security property under test is EXTEND-ONLY — a short
// portal-opened window must never cut short a longer operator-opened one.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isRegistrationOpen,
  openRegistrationWindow,
  closeRegistrationWindow,
  registrationWindowExpiry,
  getWindowAccountId,
} from "../../oauth-registration-window.js";

afterEach(() => closeRegistrationWindow());

test("closed by default", () => {
  closeRegistrationWindow();
  assert.equal(isRegistrationOpen(1000), false);
  assert.equal(registrationWindowExpiry(), 0);
});

test("open sets expiry to now+ttl; open is exclusive of the expiry instant", () => {
  closeRegistrationWindow();
  // Third param is now (epoch ms)
  const expiry = openRegistrationWindow(5 * 60_000, undefined, 1_000_000);
  assert.equal(expiry, 1_000_000 + 5 * 60_000);
  assert.equal(isRegistrationOpen(1_000_000), true);
  assert.equal(isRegistrationOpen(1_000_000 + 5 * 60_000 - 1), true);
  assert.equal(isRegistrationOpen(1_000_000 + 5 * 60_000), false);
});

test("extend-only: a shorter, later call never shortens a longer window", () => {
  closeRegistrationWindow();
  openRegistrationWindow(60 * 60_000, undefined, 1_000_000); // operator: +60min
  const after = openRegistrationWindow(5 * 60_000, undefined, 1_100_000); // friend: +5min, earlier expiry
  assert.equal(after, 1_000_000 + 60 * 60_000); // unchanged
  assert.equal(isRegistrationOpen(1_500_000), true);
});

test("extend: a later call CAN push the expiry further out", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, undefined, 1_000_000);
  const after = openRegistrationWindow(5 * 60_000, undefined, 1_200_000);
  assert.equal(after, 1_200_000 + 5 * 60_000);
});

test("close forces the window shut", () => {
  openRegistrationWindow(60 * 60_000, undefined, 1_000_000);
  closeRegistrationWindow();
  assert.equal(isRegistrationOpen(1_000_000), false);
});

test("openRegistrationWindow with accountId stores it", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, "acct-a");
  assert.equal(getWindowAccountId(), "acct-a");
});

test("openRegistrationWindow without accountId (undefined) leaves existing unchanged", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, "acct-a");
  openRegistrationWindow(60 * 60_000, undefined);
  assert.equal(getWindowAccountId(), "acct-a");
});

test("openRegistrationWindow with null clears binding", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, "acct-a");
  openRegistrationWindow(5 * 60_000, null);
  assert.equal(getWindowAccountId(), null);
});

test("closeRegistrationWindow clears accountId", () => {
  openRegistrationWindow(5 * 60_000, "acct-a");
  closeRegistrationWindow();
  assert.equal(getWindowAccountId(), null);
});
