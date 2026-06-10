// src/billing/__tests__/account-plan.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getAccountPlan,
  getBillingRow,
  setStripeCustomerId,
  accountIdForCustomer,
  applySubscriptionState,
  recordBillingEvent,
  deleteBillingEvent,
  __clearPlanCache,
} from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

interface Acct {
  id: string; plan: string; plan_status: string | null;
  plan_comp: boolean;
  current_period_end: Date | null; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; email: string | null;
}

let accounts: Map<string, Acct>;
let events: Set<string>;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT plan FROM account WHERE id=\$1/i.test(sql)) {
        const a = accounts.get(params[0]);
        return { rows: a ? [{ plan: a.plan }] : [] };
      }
      if (/SELECT plan, plan_status/i.test(sql)) {
        const a = accounts.get(params[0]);
        return { rows: a ? [a] : [] };
      }
      if (/UPDATE account SET stripe_customer_id=\$2 WHERE id=\$1/i.test(sql)) {
        const a = accounts.get(params[0]); if (a) a.stripe_customer_id = params[1];
        return { rows: [], rowCount: a ? 1 : 0 };
      }
      if (/SELECT id, plan_comp FROM account WHERE stripe_customer_id=\$1/i.test(sql)) {
        for (const a of accounts.values()) if (a.stripe_customer_id === params[0]) return { rows: [{ id: a.id, plan_comp: a.plan_comp }] };
        return { rows: [] };
      }
      if (/SELECT id FROM account WHERE stripe_customer_id=\$1/i.test(sql)) {
        for (const a of accounts.values()) if (a.stripe_customer_id === params[0]) return { rows: [{ id: a.id }] };
        return { rows: [] };
      }
      if (/UPDATE account SET plan=\$2, plan_status=\$3/i.test(sql)) {
        for (const a of accounts.values()) {
          if (a.stripe_customer_id === params[0]) {
            a.plan = params[1]; a.plan_status = params[2];
            a.stripe_subscription_id = params[3]; a.current_period_end = params[4];
            return { rows: [{ id: a.id }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO billing_events/i.test(sql)) {
        if (events.has(params[0])) return { rows: [], rowCount: 0 };
        events.add(params[0]); return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM billing_events/i.test(sql)) {
        const had = events.delete(params[0]); return { rows: [], rowCount: had ? 1 : 0 };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  accounts = new Map([
    ["friend:1", { id: "friend:1", plan: "free", plan_status: null, plan_comp: false, current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null, email: "a@b.com" }],
  ]);
  events = new Set();
  __setPoolForTest(memPool() as never);
  __clearPlanCache();
});
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("getAccountPlan reads plan; missing account defaults to free", async () => {
  assert.equal(await getAccountPlan("friend:1"), "free");
  assert.equal(await getAccountPlan("nope"), "free");
});

test("getAccountPlan caches (second call doesn't re-query)", async () => {
  assert.equal(await getAccountPlan("friend:1"), "free");
  accounts.get("friend:1")!.plan = "pro"; // change underlying
  assert.equal(await getAccountPlan("friend:1"), "free"); // still cached
  __clearPlanCache();
  assert.equal(await getAccountPlan("friend:1"), "pro");
});

test("setStripeCustomerId + accountIdForCustomer", async () => {
  await setStripeCustomerId("friend:1", "cus_123");
  assert.equal(await accountIdForCustomer("cus_123"), "friend:1");
  assert.equal(await accountIdForCustomer("cus_none"), null);
});

test("applySubscriptionState updates by customer and busts cache", async () => {
  await setStripeCustomerId("friend:1", "cus_123");
  assert.equal(await getAccountPlan("friend:1"), "free"); // warms cache
  const id = await applySubscriptionState({
    customerId: "cus_123", plan: "pro", status: "active",
    subscriptionId: "sub_1", currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
  });
  assert.equal(id, "friend:1");
  assert.equal(await getAccountPlan("friend:1"), "pro"); // cache busted
  const row = await getBillingRow("friend:1");
  assert.equal(row?.plan_status, "active");
  assert.equal(row?.stripe_subscription_id, "sub_1");
});

test("applySubscriptionState for unknown customer returns null", async () => {
  const id = await applySubscriptionState({ customerId: "cus_x", plan: "pro", status: "active", subscriptionId: "s", currentPeriodEnd: null });
  assert.equal(id, null);
});

test("recordBillingEvent is idempotent; deleteBillingEvent allows retry", async () => {
  assert.equal(await recordBillingEvent("evt_1", "x", "friend:1"), true);  // new
  assert.equal(await recordBillingEvent("evt_1", "x", "friend:1"), false); // duplicate
  await deleteBillingEvent("evt_1");
  assert.equal(await recordBillingEvent("evt_1", "x", "friend:1"), true);  // retryable
});
