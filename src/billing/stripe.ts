// src/billing/stripe.ts
// Lazy Stripe client. The API version is the SDK's pinned default (do NOT set
// apiVersion — let the installed SDK choose, so types and runtime agree). The
// key comes from env only (STRIPE_SECRET_KEY); the live key lives only in the
// VPS .env and enters at go-live with Bruno's ok.
import Stripe from "stripe";

let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  client = new Stripe(key);
  return client;
}

/** Test seam: inject a fake Stripe (or null to reset). */
export function __setStripeForTest(c: unknown): void {
  client = c as Stripe | null;
}
