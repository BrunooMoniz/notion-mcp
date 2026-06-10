// src/billing/__tests__/comp-plan.test.ts
// TDD for comp-plan helpers (grantCompPlan / revokeCompPlan), the
// applySubscriptionState guard that protects comp accounts from Stripe overwrite,
// and enforcement confirmation that a comp ilimitado account is never hard-blocked.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { grantCompPlan, revokeCompPlan, CompGrantError } from "../comp-plan.js";
import { applySubscriptionState, __clearPlanCache } from "../account-plan.js";
import { assertCreditsWithinLimit, QuotaExceededError } from "../usage.js";
import { __setPoolForTest } from "../../rag/storage.js";

// ---------------------------------------------------------------------------
// In-memory account store shared by all helpers
// ---------------------------------------------------------------------------

interface MemAcct {
  id: string;
  kind: string | null;
  plan: string | null;
  plan_comp: boolean;
  plan_status: string | null;
  stripe_customer_id: string | null;
}

let db: Map<string, MemAcct>;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      // getAccountRow (used by grantCompPlan / revokeCompPlan)
      if (/SELECT kind, plan_comp, plan FROM account WHERE id=\$1/i.test(sql)) {
        const a = db.get(params[0]);
        return { rows: a ? [{ kind: a.kind, plan_comp: a.plan_comp, plan: a.plan }] : [] };
      }
      // getBillingRow (used by test assertions)
      if (/SELECT plan, plan_status, plan_comp/i.test(sql)) {
        const a = db.get(params[0]);
        return { rows: a ? [{ plan: a.plan, plan_status: a.plan_status, plan_comp: a.plan_comp, current_period_end: null, stripe_customer_id: a.stripe_customer_id, stripe_subscription_id: null }] : [] };
      }
      // getAccountPlan cache miss
      if (/SELECT plan FROM account WHERE id=\$1/i.test(sql)) {
        const a = db.get(params[0]);
        return { rows: a ? [{ plan: a.plan }] : [] };
      }
      // grantCompPlan write
      if (/UPDATE account SET plan=\$2, plan_comp=true/i.test(sql)) {
        const a = db.get(params[0]);
        if (a) { a.plan = params[1]; a.plan_comp = true; a.plan_status = "comp"; }
        return { rows: [], rowCount: a ? 1 : 0 };
      }
      // revokeCompPlan write
      if (/UPDATE account SET plan='free', plan_comp=false/i.test(sql)) {
        const a = db.get(params[0]);
        if (a) { a.plan = "free"; a.plan_comp = false; a.plan_status = null; }
        return { rows: [], rowCount: a ? 1 : 0 };
      }
      // applySubscriptionState lookup (plan_comp guard)
      if (/SELECT id, plan_comp FROM account WHERE stripe_customer_id=\$1/i.test(sql)) {
        for (const a of db.values()) {
          if (a.stripe_customer_id === params[0]) {
            return { rows: [{ id: a.id, plan_comp: a.plan_comp }] };
          }
        }
        return { rows: [] };
      }
      // applySubscriptionState write (normal path, no comp guard triggered)
      if (/UPDATE account SET plan=\$2, plan_status=\$3/i.test(sql)) {
        for (const a of db.values()) {
          if (a.stripe_customer_id === params[0]) {
            a.plan = params[1]; a.plan_status = params[2];
            return { rows: [{ id: a.id }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }
      // setStripeCustomerId
      if (/UPDATE account SET stripe_customer_id=\$2 WHERE id=\$1/i.test(sql)) {
        const a = db.get(params[0]); if (a) a.stripe_customer_id = params[1];
        return { rows: [], rowCount: a ? 1 : 0 };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  db = new Map([
    ["friend:1", { id: "friend:1", kind: "friend", plan: "free",  plan_comp: false, plan_status: null,     stripe_customer_id: "cus_friend1" }],
    ["owner:1",  { id: "owner:1",  kind: "owner",  plan: "owner", plan_comp: false, plan_status: null,     stripe_customer_id: null           }],
    ["paying:1", { id: "paying:1", kind: "friend", plan: "pro",   plan_comp: false, plan_status: "active", stripe_customer_id: "cus_paying1"  }],
    ["comp:1",   { id: "comp:1",   kind: "friend", plan: "ilimitado", plan_comp: true,  plan_status: "comp", stripe_customer_id: "cus_comp1" }],
  ]);
  process.env.STRIPE_PRICE_PRO = "price_pro";
  __setPoolForTest(memPool() as never);
  __clearPlanCache();
});

afterEach(() => {
  __setPoolForTest(null);
  __clearPlanCache();
  delete process.env.STRIPE_PRICE_PRO;
});

// ---------------------------------------------------------------------------
// grantCompPlan
// ---------------------------------------------------------------------------

test("grantCompPlan: sets plan=ilimitado, plan_comp=true, plan_status=comp", async () => {
  await grantCompPlan("friend:1", "ilimitado");
  const a = db.get("friend:1")!;
  assert.equal(a.plan, "ilimitado");
  assert.equal(a.plan_comp, true);
  assert.equal(a.plan_status, "comp");
});

test("grantCompPlan: defaults plan to ilimitado when omitted", async () => {
  await grantCompPlan("friend:1");
  assert.equal(db.get("friend:1")!.plan, "ilimitado");
});

test("grantCompPlan: works for any non-owner plan (e.g. pro)", async () => {
  await grantCompPlan("friend:1", "pro");
  assert.equal(db.get("friend:1")!.plan, "pro");
  assert.equal(db.get("friend:1")!.plan_comp, true);
});

test("grantCompPlan: throws CompGrantError for owner account", async () => {
  await assert.rejects(
    () => grantCompPlan("owner:1"),
    (e: any) => {
      assert.ok(e instanceof CompGrantError);
      assert.ok(e.message.includes("owner"));
      return true;
    },
  );
});

test("grantCompPlan: throws CompGrantError for non-existent account", async () => {
  await assert.rejects(
    () => grantCompPlan("ghost:999"),
    (e: any) => {
      assert.ok(e instanceof CompGrantError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// revokeCompPlan
// ---------------------------------------------------------------------------

test("revokeCompPlan: resets comp account to free", async () => {
  await revokeCompPlan("comp:1");
  const a = db.get("comp:1")!;
  assert.equal(a.plan, "free");
  assert.equal(a.plan_comp, false);
  assert.equal(a.plan_status, null);
});

test("revokeCompPlan: returns true when account was comp", async () => {
  const result = await revokeCompPlan("comp:1");
  assert.equal(result, true);
});

test("revokeCompPlan: returns false and does NOT touch a paying Stripe account (plan_comp=false)", async () => {
  const before = { plan: db.get("paying:1")!.plan, plan_status: db.get("paying:1")!.plan_status };
  const result = await revokeCompPlan("paying:1");
  assert.equal(result, false);
  // Stripe-paying account must be unchanged
  assert.equal(db.get("paying:1")!.plan, before.plan);
  assert.equal(db.get("paying:1")!.plan_status, before.plan_status);
});

test("revokeCompPlan: returns false and is a no-op for a plain free account", async () => {
  const result = await revokeCompPlan("friend:1");
  assert.equal(result, false);
  assert.equal(db.get("friend:1")!.plan, "free");
  assert.equal(db.get("friend:1")!.plan_comp, false);
});

// ---------------------------------------------------------------------------
// Stripe guard: applySubscriptionState must not overwrite comp accounts
// ---------------------------------------------------------------------------

test("webhook guard: comp account is NOT overwritten by Stripe subscription event", async () => {
  // comp:1 has plan_comp=true, plan=ilimitado.
  // Simulate a Stripe subscription.updated with a different plan.
  const id = await applySubscriptionState({
    customerId: "cus_comp1",
    plan: "free",
    status: "canceled",
    subscriptionId: null,
    currentPeriodEnd: null,
  });
  // Returns the account id (found it), but does NOT write
  assert.equal(id, "comp:1");
  // Plan must be unchanged
  assert.equal(db.get("comp:1")!.plan, "ilimitado");
  assert.equal(db.get("comp:1")!.plan_comp, true);
  assert.equal(db.get("comp:1")!.plan_status, "comp");
});

test("webhook guard: normal (non-comp) account IS updated by Stripe", async () => {
  const id = await applySubscriptionState({
    customerId: "cus_paying1",
    plan: "free",
    status: "canceled",
    subscriptionId: null,
    currentPeriodEnd: null,
  });
  assert.equal(id, "paying:1");
  assert.equal(db.get("paying:1")!.plan, "free");
  assert.equal(db.get("paying:1")!.plan_status, "canceled");
});

// ---------------------------------------------------------------------------
// Enforcement: comp ilimitado account is NEVER hard-blocked
// ---------------------------------------------------------------------------

test("enforcement: comp ilimitado account is never hard-blocked by credits", async () => {
  process.env.PLAN_ENFORCEMENT = "hard";
  // Provide a pool stub that returns plan='ilimitado' for the plan query
  // and way-over credits for the credit query — simulating a heavy user.
  // The ilimitado plan must soft-alert only, never throw, regardless of comp.
  __setPoolForTest({
    query: async (sql: string, _params: any[]) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan: "ilimitado" }] };
      if (/GROUP BY metric/i.test(sql)) return { rows: [{ metric: "search", total: "99999" }] };
      return { rows: [] };
    },
  } as never);
  __clearPlanCache();
  // Must NOT throw — ilimitado is never hard-blocked per spec §2.
  await assertCreditsWithinLimit("comp:1", "search", 1);
  delete process.env.PLAN_ENFORCEMENT;
});
