// src/billing/__tests__/plans.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  PLANS,
  PAID_PLANS,
  getPlanLimits,
  isUnlimited,
  priceIdForPlan,
  planFromPriceId,
} from "../plans.js";

afterEach(() => {
  delete process.env.STRIPE_PRICE_ESSENCIAL;
  delete process.env.STRIPE_PRICE_PRO;
  delete process.env.STRIPE_PRICE_ILIMITADO;
});

test("matrix matches the locked spec §3 numbers", () => {
  assert.equal(PLANS.free.maxChunks, 2000);
  assert.equal(PLANS.free.searchesPerMonth, 100);
  assert.equal(PLANS.free.onDemandPagesPerDay, 0);
  assert.equal(PLANS.free.syncIntervalHours, null);
  assert.equal(PLANS.free.features.granolaCalendar, false);

  assert.equal(PLANS.essencial.priceBRLCents, 499);
  assert.equal(PLANS.essencial.maxChunks, 10000);
  assert.equal(PLANS.essencial.features.granolaCalendar, true);
  assert.equal(PLANS.essencial.features.classifierRevisitar, false);

  assert.equal(PLANS.pro.priceBRLCents, 999);
  assert.equal(PLANS.pro.maxWorkspaces, 3);
  assert.equal(PLANS.pro.features.briefing, true);

  assert.equal(PLANS.ilimitado.priceBRLCents, 1899);
  assert.equal(PLANS.ilimitado.maxChunks, 150000);
});

test("F7 credit limits match spec §2 table", () => {
  assert.equal(PLANS.free.monthly_credits, 100);
  assert.equal(PLANS.free.actions_per_month, 0);

  assert.equal(PLANS.essencial.monthly_credits, 1500);
  assert.equal(PLANS.essencial.actions_per_month, 30);

  assert.equal(PLANS.pro.monthly_credits, 8000);
  assert.equal(PLANS.pro.actions_per_month, 200);

  assert.equal(PLANS.ilimitado.monthly_credits, 30000);
  assert.equal(PLANS.ilimitado.actions_per_month, Number.POSITIVE_INFINITY);

  assert.equal(PLANS.owner.monthly_credits, Number.POSITIVE_INFINITY);
  assert.equal(PLANS.owner.actions_per_month, Number.POSITIVE_INFINITY);
});

test("getPlanLimits defaults unknown/missing plan to free", () => {
  assert.equal(getPlanLimits(undefined).id, "free");
  assert.equal(getPlanLimits("bogus").id, "free");
  assert.equal(getPlanLimits("pro").id, "pro");
});

test("isUnlimited only for owner", () => {
  assert.equal(isUnlimited("owner"), true);
  assert.equal(isUnlimited("ilimitado"), false);
  assert.equal(isUnlimited(undefined), false);
});

test("PAID_PLANS are exactly the three paid tiers", () => {
  assert.deepEqual(PAID_PLANS, ["essencial", "pro", "ilimitado"]);
});

test("price <-> plan mapping reads env and round-trips", () => {
  process.env.STRIPE_PRICE_ESSENCIAL = "price_ess";
  process.env.STRIPE_PRICE_PRO = "price_pro";
  process.env.STRIPE_PRICE_ILIMITADO = "price_ili";
  assert.equal(priceIdForPlan("pro"), "price_pro");
  assert.equal(planFromPriceId("price_ess"), "essencial");
  assert.equal(planFromPriceId("price_unknown"), null);
});
