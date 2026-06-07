// src/billing/webhook.ts
// Stripe webhook: verifies the signature against the raw body, dedupes by event
// id (billing_events), and maps the subscription state onto the account. The
// account is ALWAYS resolved from the Stripe customer id we stored (never from
// client-supplied data). The DB is a cache; Stripe is the source of truth.
import express from "express";
import type Stripe from "stripe";
import { getStripe } from "./stripe.js";
import { planFromPriceId } from "./plans.js";
import {
  applySubscriptionState,
  accountIdForCustomer,
  setStripeCustomerId,
  markPastDue,
  recordBillingEvent,
  deleteBillingEvent,
} from "./account-plan.js";

function customerIdOf(obj: any): string | null {
  const c = obj?.customer;
  return typeof c === "string" ? c : c?.id ?? null;
}

/** Unix-seconds period end, tolerant of the API moving it onto subscription items. */
function periodEndOf(sub: any): Date | null {
  const unix = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
  return unix ? new Date(unix * 1000) : null;
}

/** Apply a verified, de-duplicated event to the DB. Idempotent operations only. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as any;
      const customerId = customerIdOf(s);
      const accountId = s.client_reference_id || s.metadata?.account_id || null;
      // Ensure the customer is linked to the account (Checkout may have created it).
      if (customerId && accountId) await setStripeCustomerId(accountId, customerId);
      // The plan itself is set by the subscription.created/updated event.
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as any;
      const customerId = customerIdOf(sub);
      if (!customerId) return;
      const priceId = sub.items?.data?.[0]?.price?.id ?? "";
      const plan = planFromPriceId(priceId);
      const status: string = sub.status ?? "active";
      // active/trialing/past_due keep the paid plan; anything else -> free.
      const keepPaid = status === "active" || status === "trialing" || status === "past_due";
      const effectivePlan = keepPaid && plan ? plan : "free";
      await applySubscriptionState({
        customerId,
        plan: effectivePlan,
        status,
        subscriptionId: sub.id ?? null,
        currentPeriodEnd: periodEndOf(sub),
      });
      return;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as any;
      const customerId = customerIdOf(sub);
      if (!customerId) return;
      await applySubscriptionState({
        customerId, plan: "free", status: "canceled", subscriptionId: null, currentPeriodEnd: null,
      });
      return;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as any;
      const customerId = customerIdOf(inv);
      if (!customerId) return;
      const accountId = await accountIdForCustomer(customerId);
      if (accountId) await markPastDue(accountId);
      return;
    }
    default:
      return; // ignore everything else
  }
}

export function createStripeWebhookRouter(): express.Router {
  const router = express.Router();
  // raw body ONLY on this path (signature verification needs the exact bytes).
  router.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) { res.status(503).json({ error: "billing not configured" }); return; }
    const sig = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(req.body as Buffer, sig as string, secret);
    } catch (err: any) {
      console.warn(`[billing] webhook signature failed: ${err?.message ?? err}`);
      res.status(400).json({ error: "invalid signature" });
      return;
    }
    try {
      const customerId = customerIdOf(event.data.object as any);
      const accountId = customerId ? await accountIdForCustomer(customerId).catch(() => null) : null;
      const isNew = await recordBillingEvent(event.id, event.type, accountId);
      if (!isNew) { res.json({ received: true, duplicate: true }); return; }
      try {
        await handleStripeEvent(event);
      } catch (e) {
        await deleteBillingEvent(event.id).catch(() => {}); // allow Stripe retry
        throw e;
      }
      res.json({ received: true });
    } catch (err: any) {
      console.error(`[billing] webhook handler error: ${err?.message ?? err}`);
      res.status(500).json({ error: "handler error" });
    }
  });
  return router;
}
