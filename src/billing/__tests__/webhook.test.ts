// src/billing/__tests__/webhook.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleStripeEvent } from "../webhook.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

interface Acct { id: string; plan: string; plan_status: string | null; plan_comp: boolean; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end: Date | null }
let accounts: Map<string, Acct>;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT id, plan_comp FROM account WHERE stripe_customer_id=\$1/i.test(sql)) {
        for (const a of accounts.values()) if (a.stripe_customer_id === params[0]) return { rows: [{ id: a.id, plan_comp: a.plan_comp }] };
        return { rows: [] };
      }
      if (/UPDATE account SET plan=\$2, plan_status=\$3/i.test(sql)) {
        for (const a of accounts.values()) if (a.stripe_customer_id === params[0]) {
          a.plan = params[1]; a.plan_status = params[2]; a.stripe_subscription_id = params[3]; a.current_period_end = params[4];
          return { rows: [{ id: a.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE account SET stripe_customer_id=\$2/i.test(sql)) {
        const a = accounts.get(params[0]); if (a) a.stripe_customer_id = params[1]; return { rows: [], rowCount: a ? 1 : 0 };
      }
      if (/UPDATE account SET plan_status='past_due'/i.test(sql)) {
        const a = accounts.get(params[0]); if (a) a.plan_status = "past_due"; return { rows: [], rowCount: a ? 1 : 0 };
      }
      if (/SELECT id FROM account WHERE stripe_customer_id=\$1/i.test(sql)) {
        for (const a of accounts.values()) if (a.stripe_customer_id === params[0]) return { rows: [{ id: a.id }] };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  accounts = new Map([["friend:1", { id: "friend:1", plan: "free", plan_status: null, plan_comp: false, stripe_customer_id: "cus_1", stripe_subscription_id: null, current_period_end: null }]]);
  process.env.STRIPE_PRICE_PRO = "price_pro";
  __setPoolForTest(memPool() as never);
  __clearPlanCache();
});
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); delete process.env.STRIPE_PRICE_PRO; });

test("subscription.updated active -> sets plan from price id", async () => {
  await handleStripeEvent({
    id: "evt_1", type: "customer.subscription.updated",
    data: { object: { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1781000000, items: { data: [{ price: { id: "price_pro" } }] } } },
  } as never);
  assert.equal(accounts.get("friend:1")!.plan, "pro");
  assert.equal(accounts.get("friend:1")!.plan_status, "active");
});

test("subscription.deleted -> back to free", async () => {
  accounts.get("friend:1")!.plan = "pro";
  await handleStripeEvent({
    id: "evt_2", type: "customer.subscription.deleted",
    data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", items: { data: [{ price: { id: "price_pro" } }] } } },
  } as never);
  assert.equal(accounts.get("friend:1")!.plan, "free");
  assert.equal(accounts.get("friend:1")!.plan_status, "canceled");
});

test("invoice.payment_failed -> past_due, plan kept", async () => {
  accounts.get("friend:1")!.plan = "pro";
  await handleStripeEvent({
    id: "evt_3", type: "invoice.payment_failed",
    data: { object: { customer: "cus_1" } },
  } as never);
  assert.equal(accounts.get("friend:1")!.plan, "pro");
  assert.equal(accounts.get("friend:1")!.plan_status, "past_due");
});

test("unknown event type is ignored (no throw)", async () => {
  await handleStripeEvent({ id: "evt_4", type: "charge.succeeded", data: { object: {} } } as never);
});
