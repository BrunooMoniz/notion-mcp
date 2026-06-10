// src/billing/plans.ts
// Single source of truth for the freemium plan matrix (spec §3). Pure: no DB,
// no Stripe. The owner sentinel ('owner') is unlimited; the three paid plans map
// to Stripe price ids via env (set by scripts/stripe-setup-prices.mts).
//
// F7: monthly_credits and actions_per_month added (spec §2 — planos v2).
// Existing fields kept for backward compat.

export type PlanId = "free" | "essencial" | "pro" | "ilimitado" | "owner";

export interface PlanFeatures {
  granolaCalendar: boolean;
  classifierRevisitar: boolean;
  briefing: boolean;
}

export interface PlanLimits {
  id: PlanId;
  label: string;
  priceBRLCents: number; // 0 for free/owner
  maxWorkspaces: number;
  maxChunks: number;
  searchesPerMonth: number;
  onDemandPagesPerDay: number; // 0 = on-demand indexing not included
  syncIntervalHours: number | null; // null = manual only (no auto re-sync)
  features: PlanFeatures;
  // F7 — unified credit limits (spec §2)
  monthly_credits: number; // total credits/month; UNLIMITED for owner
  actions_per_month: number; // portal action executions/month; UNLIMITED for owner
}

/** Sentinel limit for the owner plan (serializes to null in JSON; UI shows "ilimitado"). */
export const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free", label: "Free", priceBRLCents: 0,
    maxWorkspaces: 1, maxChunks: 2_000, searchesPerMonth: 100,
    onDemandPagesPerDay: 0, syncIntervalHours: null,
    features: { granolaCalendar: false, classifierRevisitar: false, briefing: false },
    monthly_credits: 100,
    actions_per_month: 0,
  },
  essencial: {
    id: "essencial", label: "Essencial", priceBRLCents: 499,
    maxWorkspaces: 1, maxChunks: 10_000, searchesPerMonth: 1_000,
    onDemandPagesPerDay: 50, syncIntervalHours: 24,
    features: { granolaCalendar: true, classifierRevisitar: false, briefing: false },
    monthly_credits: 1_500,
    actions_per_month: 30,
  },
  pro: {
    id: "pro", label: "Pro", priceBRLCents: 999,
    maxWorkspaces: 3, maxChunks: 40_000, searchesPerMonth: 5_000,
    onDemandPagesPerDay: 200, syncIntervalHours: 6,
    features: { granolaCalendar: true, classifierRevisitar: true, briefing: true },
    monthly_credits: 8_000,
    actions_per_month: 200,
  },
  ilimitado: {
    id: "ilimitado", label: "Ilimitado", priceBRLCents: 1899,
    maxWorkspaces: 5, maxChunks: 150_000, searchesPerMonth: 20_000,
    onDemandPagesPerDay: 500, syncIntervalHours: 1,
    features: { granolaCalendar: true, classifierRevisitar: true, briefing: true },
    monthly_credits: 30_000, // soft cap — never hard-blocked (spec §2)
    actions_per_month: UNLIMITED,
  },
  owner: {
    id: "owner", label: "Owner", priceBRLCents: 0,
    maxWorkspaces: UNLIMITED, maxChunks: UNLIMITED, searchesPerMonth: UNLIMITED,
    onDemandPagesPerDay: UNLIMITED, syncIntervalHours: 1,
    features: { granolaCalendar: true, classifierRevisitar: true, briefing: true },
    monthly_credits: UNLIMITED,
    actions_per_month: UNLIMITED,
  },
};

export const PAID_PLANS: PlanId[] = ["essencial", "pro", "ilimitado"];

export function getPlanLimits(plan: string | null | undefined): PlanLimits {
  const id = (plan ?? "free") as PlanId;
  return PLANS[id] ?? PLANS.free;
}

export function isUnlimited(plan: string | null | undefined): boolean {
  return (plan ?? "free") === "owner";
}

export function priceIdForPlan(plan: PlanId): string | undefined {
  switch (plan) {
    case "essencial": return process.env.STRIPE_PRICE_ESSENCIAL;
    case "pro": return process.env.STRIPE_PRICE_PRO;
    case "ilimitado": return process.env.STRIPE_PRICE_ILIMITADO;
    default: return undefined;
  }
}

export function planFromPriceId(priceId: string): PlanId | null {
  if (priceId && priceId === process.env.STRIPE_PRICE_ESSENCIAL) return "essencial";
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId && priceId === process.env.STRIPE_PRICE_ILIMITADO) return "ilimitado";
  return null;
}
