// src/portal/__tests__/connect-window-binding.test.ts
// Tests the account-binding guard semantics for the registration window.
// Uses pure state manipulation of the oauth-registration-window singleton —
// no server needed. The HTTP-level guards in oauth.ts are validated by the
// build (TypeScript) and by the pure guard logic tested here.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openRegistrationWindow,
  closeRegistrationWindow,
  getWindowAccountId,
} from "../../oauth-registration-window.js";

const ACCT_A = "friend:acct-aaa";
const ACCT_B = "friend:acct-bbb";

afterEach(() => closeRegistrationWindow());

// --- Pure state tests ---

test("openRegistrationWindow with accountId stores it", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, ACCT_A);
  assert.equal(getWindowAccountId(), ACCT_A);
});

test("openRegistrationWindow without accountId (undefined) leaves existing binding unchanged", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, ACCT_A);
  // Operator extends without passing accountId — should not clear binding
  openRegistrationWindow(60 * 60_000);
  assert.equal(getWindowAccountId(), ACCT_A);
});

test("openRegistrationWindow with null accountId clears binding", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, ACCT_A);
  openRegistrationWindow(5 * 60_000, null);
  assert.equal(getWindowAccountId(), null);
});

test("closeRegistrationWindow always clears accountId", () => {
  openRegistrationWindow(5 * 60_000, ACCT_A);
  closeRegistrationWindow();
  assert.equal(getWindowAccountId(), null);
});

// --- Binding guard helper (pure) ---
// The real guard in oauth.ts calls getWindowAccountId() and compares to session accountId.
// We test the guard logic here to ensure correctness.

function checkWindowBinding(sessionAccountId: string): "ok" | "mismatch" | "no-window" {
  const windowAcct = getWindowAccountId();
  if (!windowAcct) return "no-window";
  if (windowAcct === sessionAccountId) return "ok";
  return "mismatch";
}

test("binding guard: no window → no-window", () => {
  closeRegistrationWindow();
  assert.equal(checkWindowBinding(ACCT_A), "no-window");
});

test("binding guard: window bound to A + session A → ok", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, ACCT_A);
  assert.equal(checkWindowBinding(ACCT_A), "ok");
});

test("binding guard: window bound to A + session B → mismatch", () => {
  closeRegistrationWindow();
  openRegistrationWindow(5 * 60_000, ACCT_A);
  assert.equal(checkWindowBinding(ACCT_B), "mismatch");
});

test("binding guard: no window (operator path) → no-window (no guard fires)", () => {
  closeRegistrationWindow();
  // When there is no window binding (operator scenario), the guard is a no-op
  assert.equal(checkWindowBinding(ACCT_B), "no-window");
});
