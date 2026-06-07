// src/billing/__tests__/stripe.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getStripe, __setStripeForTest } from "../stripe.js";

afterEach(() => { __setStripeForTest(null); delete process.env.STRIPE_SECRET_KEY; });

test("getStripe throws a clear error when STRIPE_SECRET_KEY is unset", () => {
  __setStripeForTest(null);
  assert.throws(() => getStripe(), /STRIPE_SECRET_KEY not set/);
});

test("getStripe returns the injected client in tests", () => {
  const fake = { fake: true } as never;
  __setStripeForTest(fake);
  assert.equal(getStripe(), fake);
});
