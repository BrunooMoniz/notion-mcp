# Fase 3 — Billing + Freemium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Zinom (`notion-mcp`) into a real freemium product: a Free plan with cost-protecting caps plus 3 paid plans (R$4,99 / R$9,99 / R$18,99/mês) with enforced limits and Stripe billing, all inside the existing multi-tenant backend and the `/app.html` portal.

**Architecture:** A new `src/billing/*` module is the single source of truth for plans, plan resolution, usage queries, and quota enforcement. Enforcement is an **additive layer on top** of the existing `account_id`+workspace isolation guard (it never touches `buildFilterClauses`/`brainSearch` SQL). Every quota check short-circuits for the owner/default account (`DEFAULT_ACCOUNT_ID = "bruno"`), so Bruno's behavior and all existing tests are unchanged. Stripe runs hosted (Checkout + Customer Portal + webhook); the DB is a cache updated by the verified webhook.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Express 4, PostgreSQL + pgvector (`pg`), `stripe` Node SDK, `node:test` + `node:assert/strict` with an injected in-memory pool (`__setPoolForTest`).

**Spec:** `docs/superpowers/specs/2026-06-06-fase3-billing-freemium-design.md`
**Code repo / working copy:** `BrunooMoniz/notion-mcp`, working copy at `.context/notion-mcp` (branch `main`). **All paths below are relative to that working copy** unless absolute.

---

## Conventions (read before any task)

- **Imports use the `.js` suffix** even for `.ts` sources (NodeNext). E.g. `import { getPool } from "../rag/storage.js";`.
- **Named exports only.** No default exports.
- **One shared pg pool:** `import { getPool, closePool, hasInjectedPool, __setPoolForTest } from "../rag/storage.js"`. Never construct your own `pg.Pool`.
- **Best-effort vs throwing:** telemetry writers (`recordUsage`, `recordRun`) swallow errors and never throw. Core paths let `pg` errors propagate. Quota checks **throw a typed error** (never swallowed).
- **account_id always comes from the server** (`getAccountId()` / `res.locals.accountId` / resolved bearer), never from tool args or request body.
- **Circular-import rule:** `rag/storage.ts` is imported by `billing/*`. So when `storage.ts` (or `search.ts`) needs a `billing/*` function, **lazy-import it** (`const { x } = await import("../billing/usage.js")`) exactly like `recordUsage` is lazy-imported today.
- **Tests:** `node:test`, `assert/strict`, inject a fake pool via `__setPoolForTest(memPool() as never)`, reset in `afterEach(() => __setPoolForTest(null))`, and **clear the plan cache** with `__clearPlanCache()` where used. Run a single file with `npx tsx --test src/billing/__tests__/<file>.test.ts`.
- **Migrations** are idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), applied by `npm run migrate`, and **must be mirrored** into `scripts/portal-dev-schema.sql` (the no-pgvector dev/e2e DB).
- **Commit after every task** (the last step of each task).

---

## File Structure

**New files**
- `src/billing/plans.ts` — `PlanId`, `PlanLimits`, the `PLANS` matrix (spec §3), `getPlanLimits`, `isUnlimited`, `PAID_PLANS`, `priceIdForPlan`, `planFromPriceId`. Pure, no DB.
- `src/billing/account-plan.ts` — per-account plan/billing row read+write + 60s cache: `getAccountPlan`, `getBillingRow`, `setStripeCustomerId`, `accountIdForCustomer`, `applySubscriptionState`, `recordBillingEvent`, `deleteBillingEvent`, `markPastDue`, `__clearPlanCache`.
- `src/billing/usage.ts` — `QuotaExceededError`, `monthStartUTC`, `dayStartUTC`, `queryUsage`, `countChunks`, `getUsageSnapshot`, `assertSearchWithinLimit`, `assertChunksWithinLimit`, `assertOnDemandWithinLimit`.
- `src/billing/stripe.ts` — lazy `getStripe()` client + `__setStripeForTest`.
- `src/billing/webhook.ts` — `handleStripeEvent` + `createStripeWebhookRouter` (raw body, signature verify, idempotency).
- `src/billing/resync-cron.ts` — `runResyncTick` (per-account auto re-sync respecting plan `syncIntervalHours`).
- `scripts/migrations/0009_billing.sql` — additive schema.
- `scripts/stripe-setup-prices.mts` — one-shot idempotent products/prices provisioner.
- Tests: `src/billing/__tests__/{plans,account-plan,usage,webhook,resync-cron}.test.ts`.

**Modified files**
- `package.json` — add `stripe` dep, extend `test` glob, add `stripe:prices` script.
- `scripts/portal-dev-schema.sql` — mirror the 0009 columns + `billing_events`.
- `src/rag/search.ts` — `assertSearchWithinLimit` before `recordUsage('search')`.
- `src/rag/brain-tool.ts` — catch `QuotaExceededError` → friendly result.
- `src/rag/storage.ts` — defensive chunk-cap guard in `upsertChunks`.
- `src/rag/brain-index-url-tool.ts` + `src/rag/brain-index-web-tool.ts` — on-demand feature gate + daily cap + `index_pages` metering.
- `src/rag/index-account.ts` — feature-gate the Granola + iCal passes by plan.
- `src/portal/routes.ts` — `GET /portal/billing`, `POST /portal/billing/checkout`, `POST /portal/billing/manage`; workspace-count cap on the two Notion-connect routes.
- `src/index.ts` — mount `createStripeWebhookRouter()` **before** `express.json()`.
- `src/index-classifier.ts` — schedule `runResyncTick` on cron.
- `src/admin/routes.ts` — plan / plan_status / period columns + MRR card.
- `portal/app.html`, `portal/app.js`, `portal/styles.css` — "Plano & Uso" card.

---

# Phase B0 — Schema + plans module + usage

## Task B0.1: package.json — stripe dep, test glob, prices script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the Stripe SDK**

Run (from the working copy root):
```bash
npm install stripe
```
Expected: `stripe` added under `dependencies` in `package.json` and `package-lock.json` updated.

- [ ] **Step 2: Extend the test glob and add the prices script**

In `package.json`, change the `test` script (line 14) and add a `stripe:prices` script:

```json
    "test": "tsx --test src/rag/__tests__/*.test.ts src/portal/__tests__/*.test.ts src/billing/__tests__/*.test.ts",
    "make-invite": "tsx scripts/make-invite.mts",
    "migrate": "tsx scripts/migrate.mts",
    "stripe:prices": "tsx scripts/stripe-setup-prices.mts",
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: existing suite still passes (no billing tests exist yet; the new glob matches nothing and is ignored).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(billing): add stripe dep, billing test glob, stripe:prices script"
```

---

## Task B0.2: Migration 0009 — plan columns + billing_events

**Files:**
- Create: `scripts/migrations/0009_billing.sql`
- Modify: `scripts/portal-dev-schema.sql`

- [ ] **Step 1: Write the migration**

Create `scripts/migrations/0009_billing.sql`:

```sql
-- scripts/migrations/0009_billing.sql
-- Applied by the migration runner: npm run migrate
--
-- Fase 3 billing/freemium. Additive + idempotent. Adds the plan/subscription
-- columns to `account` and a `billing_events` table for webhook idempotency.
-- Existing friend rows default to 'free'; the operator 'bruno' becomes 'owner'
-- (the unlimited sentinel) so his behavior is unchanged. Nothing is dropped.

ALTER TABLE account ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE account ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE account ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE account ADD COLUMN IF NOT EXISTS plan_status text;          -- active | past_due | canceled
ALTER TABLE account ADD COLUMN IF NOT EXISTS current_period_end timestamptz;

-- Look up an account by its Stripe customer (webhook path). Partial index: most
-- rows have NULL customer id.
CREATE UNIQUE INDEX IF NOT EXISTS account_stripe_customer_uniq
  ON account (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Owner is unlimited. Idempotent (re-running sets the same value).
UPDATE account SET plan='owner' WHERE id='bruno';

-- Webhook idempotency: one row per processed Stripe event id.
CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id text PRIMARY KEY,
  type            text NOT NULL,
  account_id      text,
  received_at     timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Mirror into the dev/e2e schema**

In `scripts/portal-dev-schema.sql`, the `CREATE TABLE IF NOT EXISTS account (...)` block currently ends with `email text`. Add the billing columns inside that block and add `billing_events` after it. Replace the `account` table block with:

```sql
CREATE TABLE IF NOT EXISTS account (
  id                     text PRIMARY KEY,
  kind                   text,
  status                 text NOT NULL DEFAULT 'active',
  created_at             timestamptz NOT NULL DEFAULT now(),
  email                  text,
  plan                   text NOT NULL DEFAULT 'free',
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan_status            text,
  current_period_end     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS account_email_uniq ON account (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_stripe_customer_uniq ON account (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id text PRIMARY KEY,
  type            text NOT NULL,
  account_id      text,
  received_at     timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 3: Verify the migration is detected (dry run, no DB writes)**

Run: `MIGRATE_DRY=1 npm run migrate`
Expected: output lists `0009_billing.sql` as pending (does not apply it). If you have a local `POSTGRES_URL`, run `npm run migrate` and confirm it applies idempotently (re-running reports nothing pending).

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/0009_billing.sql scripts/portal-dev-schema.sql
git commit -m "feat(billing): 0009 migration — account plan columns + billing_events (additive)"
```

---

## Task B0.3: `src/billing/plans.ts` — plan matrix (source of truth)

**Files:**
- Create: `src/billing/plans.ts`
- Test: `src/billing/__tests__/plans.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/plans.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/billing/__tests__/plans.test.ts`
Expected: FAIL — `Cannot find module '../plans.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/billing/plans.ts`:

```ts
// src/billing/plans.ts
// Single source of truth for the freemium plan matrix (spec §3). Pure: no DB,
// no Stripe. The owner sentinel ('owner') is unlimited; the three paid plans map
// to Stripe price ids via env (set by scripts/stripe-setup-prices.mts).

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
}

/** Sentinel limit for the owner plan (serializes to null in JSON; UI shows "ilimitado"). */
export const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free", label: "Free", priceBRLCents: 0,
    maxWorkspaces: 1, maxChunks: 2_000, searchesPerMonth: 100,
    onDemandPagesPerDay: 0, syncIntervalHours: null,
    features: { granolaCalendar: false, classifierRevisitar: false, briefing: false },
  },
  essencial: {
    id: "essencial", label: "Essencial", priceBRLCents: 499,
    maxWorkspaces: 1, maxChunks: 10_000, searchesPerMonth: 1_000,
    onDemandPagesPerDay: 50, syncIntervalHours: 24,
    features: { granolaCalendar: true, classifierRevisitar: false, briefing: false },
  },
  pro: {
    id: "pro", label: "Pro", priceBRLCents: 999,
    maxWorkspaces: 3, maxChunks: 40_000, searchesPerMonth: 5_000,
    onDemandPagesPerDay: 200, syncIntervalHours: 6,
    features: { granolaCalendar: true, classifierRevisitar: true, briefing: true },
  },
  ilimitado: {
    id: "ilimitado", label: "Ilimitado", priceBRLCents: 1899,
    maxWorkspaces: 5, maxChunks: 150_000, searchesPerMonth: 20_000,
    onDemandPagesPerDay: 500, syncIntervalHours: 1,
    features: { granolaCalendar: true, classifierRevisitar: true, briefing: true },
  },
  owner: {
    id: "owner", label: "Owner", priceBRLCents: 0,
    maxWorkspaces: UNLIMITED, maxChunks: UNLIMITED, searchesPerMonth: UNLIMITED,
    onDemandPagesPerDay: UNLIMITED, syncIntervalHours: 1,
    features: { granolaCalendar: true, classifierRevisitar: true, briefing: true },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/billing/__tests__/plans.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/billing/plans.ts src/billing/__tests__/plans.test.ts
git commit -m "feat(billing): plans matrix (spec §3) + price/plan mapping"
```

---

## Task B0.4: `src/billing/account-plan.ts` — plan read/write + idempotency

**Files:**
- Create: `src/billing/account-plan.ts`
- Test: `src/billing/__tests__/account-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/account-plan.test.ts`:

```ts
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
    ["friend:1", { id: "friend:1", plan: "free", plan_status: null, current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null, email: "a@b.com" }],
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/billing/__tests__/account-plan.test.ts`
Expected: FAIL — `Cannot find module '../account-plan.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/billing/account-plan.ts`:

```ts
// src/billing/account-plan.ts
// Per-account plan/billing row: read (with a short cache, mirroring
// account-bearer.ts) + the write paths the Stripe webhook needs. The plan is
// always resolved server-side from account_id; it never comes from user input.
import { getPool, hasInjectedPool } from "../rag/storage.js";

export interface BillingRow {
  plan: string;
  plan_status: string | null;
  current_period_end: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

const TTL_MS = 60_000;
const cache = new Map<string, { plan: string; exp: number }>();

/** Test/ops hook: drop the plan cache so a plan change takes effect immediately. */
export function __clearPlanCache(): void {
  cache.clear();
}

/** The account's plan id (e.g. 'free'|'pro'|'owner'). Missing row -> 'free'.
 *  Cached for TTL_MS; busted on any plan write. No DB? -> 'free' (light dev). */
export async function getAccountPlan(accountId: string): Promise<string> {
  const c = cache.get(accountId);
  if (c && c.exp > Date.now()) return c.plan;
  if (c) cache.delete(accountId);
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return "free";
  const p = getPool();
  const { rows } = await p.query<{ plan: string }>(`SELECT plan FROM account WHERE id=$1`, [accountId]);
  const plan = rows[0]?.plan ?? "free";
  cache.set(accountId, { plan, exp: Date.now() + TTL_MS });
  return plan;
}

export async function getBillingRow(accountId: string): Promise<BillingRow | null> {
  const p = getPool();
  const { rows } = await p.query<BillingRow>(
    `SELECT plan, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id
       FROM account WHERE id=$1`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function setStripeCustomerId(accountId: string, customerId: string): Promise<void> {
  const p = getPool();
  await p.query(`UPDATE account SET stripe_customer_id=$2 WHERE id=$1`, [accountId, customerId]);
  cache.delete(accountId);
}

export async function accountIdForCustomer(customerId: string): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ id: string }>(`SELECT id FROM account WHERE stripe_customer_id=$1`, [customerId]);
  return rows[0]?.id ?? null;
}

/** Webhook write: set plan/status/subscription by Stripe customer id. Returns the
 *  updated account id (or null if no account maps to this customer). Busts cache. */
export async function applySubscriptionState(s: {
  customerId: string;
  plan: string;
  status: string | null;
  subscriptionId: string | null;
  currentPeriodEnd: Date | null;
}): Promise<string | null> {
  const p = getPool();
  const { rows } = await p.query<{ id: string }>(
    `UPDATE account SET plan=$2, plan_status=$3, stripe_subscription_id=$4, current_period_end=$5
       WHERE stripe_customer_id=$1 RETURNING id`,
    [s.customerId, s.plan, s.status, s.subscriptionId, s.currentPeriodEnd],
  );
  const id = rows[0]?.id ?? null;
  if (id) cache.delete(id);
  return id;
}

/** Mark an account past_due (invoice.payment_failed). Keeps plan, flips status. */
export async function markPastDue(accountId: string): Promise<void> {
  const p = getPool();
  await p.query(`UPDATE account SET plan_status='past_due' WHERE id=$1`, [accountId]);
  cache.delete(accountId);
}

/** Idempotency: insert the event id. Returns true if NEW (process it), false if
 *  already seen (skip). */
export async function recordBillingEvent(eventId: string, type: string, accountId: string | null): Promise<boolean> {
  const p = getPool();
  const res = await p.query(
    `INSERT INTO billing_events (stripe_event_id, type, account_id) VALUES ($1, $2, $3)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
    [eventId, type, accountId],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Undo recordBillingEvent so a failed handler can be retried by Stripe. */
export async function deleteBillingEvent(eventId: string): Promise<void> {
  const p = getPool();
  await p.query(`DELETE FROM billing_events WHERE stripe_event_id=$1`, [eventId]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/billing/__tests__/account-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/billing/account-plan.ts src/billing/__tests__/account-plan.test.ts
git commit -m "feat(billing): account plan read/write + webhook idempotency helpers"
```

---

## Task B0.5: `src/billing/usage.ts` — usage queries + quota asserts

**Files:**
- Create: `src/billing/usage.ts`
- Test: `src/billing/__tests__/usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/usage.test.ts`:

```ts
// src/billing/__tests__/usage.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  QuotaExceededError,
  monthStartUTC,
  dayStartUTC,
  queryUsage,
  countChunks,
  getUsageSnapshot,
  assertSearchWithinLimit,
  assertChunksWithinLimit,
  assertOnDemandWithinLimit,
} from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

// Tunable fakes the memPool reads.
let plan = "free";
let searchSum = 0;
let indexPagesSum = 0;
let chunkCount = 0;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/sum\(qty\)/i.test(sql)) {
        const metric = params[1];
        const total = metric === "search" ? searchSum : metric === "index_pages" ? indexPagesSum : 0;
        return { rows: [{ total: String(total) }] };
      }
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) return { rows: [{ n: String(chunkCount) }] };
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  plan = "free"; searchSum = 0; indexPagesSum = 0; chunkCount = 0;
  __setPoolForTest(memPool() as never);
  __clearPlanCache();
});
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("monthStartUTC/dayStartUTC truncate to UTC boundaries", () => {
  const now = new Date("2026-06-17T13:45:00Z");
  assert.equal(monthStartUTC(now).toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(dayStartUTC(now).toISOString(), "2026-06-17T00:00:00.000Z");
});

test("queryUsage / countChunks read sums", async () => {
  searchSum = 42; chunkCount = 7;
  assert.equal(await queryUsage("friend:1", "search", monthStartUTC()), 42);
  assert.equal(await countChunks("friend:1"), 7);
});

test("owner account ('bruno' = DEFAULT_ACCOUNT_ID) is never limited", async () => {
  searchSum = 1_000_000; chunkCount = 1_000_000;
  await assertSearchWithinLimit("bruno");          // no throw
  await assertChunksWithinLimit("bruno", 999_999);  // no throw
  await assertOnDemandWithinLimit("bruno", 999);    // no throw
});

test("owner PLAN ('owner') is never limited even with a friend-shaped id", async () => {
  plan = "owner"; searchSum = 1_000_000; chunkCount = 1_000_000;
  await assertSearchWithinLimit("friend:op");
  await assertChunksWithinLimit("friend:op", 999_999);
});

test("free: searches blocked at/over monthly cap (100)", async () => {
  searchSum = 99; await assertSearchWithinLimit("friend:1"); // 99 < 100 ok
  searchSum = 100;
  await assert.rejects(() => assertSearchWithinLimit("friend:1"), (e: any) => {
    assert.ok(e instanceof QuotaExceededError);
    assert.equal(e.limit, 100); assert.equal(e.used, 100);
    return true;
  });
});

test("free: chunk cap (2000) blocks when current+incoming would exceed", async () => {
  chunkCount = 1990; await assertChunksWithinLimit("friend:1", 10); // 2000 == cap ok
  chunkCount = 1990;
  await assert.rejects(() => assertChunksWithinLimit("friend:1", 11), QuotaExceededError);
});

test("free: on-demand indexing not included -> always blocked", async () => {
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 1), QuotaExceededError);
});

test("essencial: on-demand daily cap (50)", async () => {
  plan = "essencial";
  indexPagesSum = 40; await assertOnDemandWithinLimit("friend:1", 10); // 50 ok
  indexPagesSum = 45;
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 10), QuotaExceededError);
});

test("getUsageSnapshot reports used+limit per metric", async () => {
  plan = "pro"; chunkCount = 100; searchSum = 5; indexPagesSum = 2;
  const snap = await getUsageSnapshot("friend:1");
  assert.equal(snap.plan, "pro");
  assert.deepEqual(snap.chunks, { used: 100, limit: 40000 });
  assert.deepEqual(snap.searches, { used: 5, limit: 5000 });
  assert.deepEqual(snap.onDemand, { used: 2, limit: 200 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/billing/__tests__/usage.test.ts`
Expected: FAIL — `Cannot find module '../usage.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/billing/usage.ts`:

```ts
// src/billing/usage.ts
// Usage queries + quota enforcement on top of the existing passive metering
// (usage_log). The owner/default account is always exempt (fast path, no DB):
// DEFAULT_ACCOUNT_ID is Bruno, and every cron/eval/test context resolves to it,
// so existing behavior and tests are unchanged. Quota breaches THROW a typed
// error (never swallowed) — the caller surfaces a clear PT-BR message.
import { getPool, hasInjectedPool } from "../rag/storage.js";
import { DEFAULT_ACCOUNT_ID } from "../context.js";
import { getAccountPlan } from "./account-plan.js";
import { getPlanLimits, isUnlimited } from "./plans.js";

export class QuotaExceededError extends Error {
  constructor(
    public readonly metric: string,
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`Limite do plano atingido (${metric}): ${used}/${limit}. Faça upgrade em zinom.ai/app.html para continuar.`);
    this.name = "QuotaExceededError";
  }
}

export function monthStartUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function dayStartUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Sum of usage_log.qty for (account, metric) since `since`. 0 when no DB. */
export async function queryUsage(accountId: string, metric: string, since: Date): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const { rows } = await p.query<{ total: string | null }>(
    `SELECT COALESCE(sum(qty),0)::text AS total FROM usage_log
       WHERE account_id=$1 AND metric=$2 AND ts >= $3`,
    [accountId, metric, since],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Current indexed chunk count for an account (the storage "level", not the
 *  usage_log 'chunks' throughput meter which double-counts re-indexing). */
export async function countChunks(accountId: string): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const { rows } = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM brain_chunks WHERE account_id=$1`,
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function assertSearchWithinLimit(accountId: string): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  const used = await queryUsage(accountId, "search", monthStartUTC());
  if (used >= limits.searchesPerMonth) {
    throw new QuotaExceededError("buscas/mês", limits.searchesPerMonth, used);
  }
}

export async function assertChunksWithinLimit(accountId: string, incoming: number): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  const current = await countChunks(accountId);
  if (current + incoming > limits.maxChunks) {
    throw new QuotaExceededError("chunks indexados", limits.maxChunks, current);
  }
}

export async function assertOnDemandWithinLimit(accountId: string, pages: number): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  if (limits.onDemandPagesPerDay <= 0) {
    throw new QuotaExceededError("indexação on-demand (não incluída no plano)", 0, 0);
  }
  const used = await queryUsage(accountId, "index_pages", dayStartUTC());
  if (used + pages > limits.onDemandPagesPerDay) {
    throw new QuotaExceededError("páginas on-demand/dia", limits.onDemandPagesPerDay, used);
  }
}

export interface UsageSnapshot {
  plan: string;
  chunks: { used: number; limit: number };
  searches: { used: number; limit: number };
  onDemand: { used: number; limit: number };
}

export async function getUsageSnapshot(accountId: string): Promise<UsageSnapshot> {
  const plan = await getAccountPlan(accountId);
  const limits = getPlanLimits(plan);
  const [chunks, searches, onDemand] = await Promise.all([
    countChunks(accountId),
    queryUsage(accountId, "search", monthStartUTC()),
    queryUsage(accountId, "index_pages", dayStartUTC()),
  ]);
  return {
    plan,
    chunks: { used: chunks, limit: limits.maxChunks },
    searches: { used: searches, limit: limits.searchesPerMonth },
    onDemand: { used: onDemand, limit: limits.onDemandPagesPerDay },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/billing/__tests__/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: COGS sanity check (one-shot, non-blocking)**

Confirm each paid plan's worst-case monthly COGS is below its price, so the caps actually protect margin. Use current vendor pricing (verify via Context7/vendor pages at execution time):
- Voyage `voyage-3-large` embeddings (indexing + query), `rerank-2.5-lite`.
- Stripe BR card fee (~3,99% + R$0,39).
Rough check: a full index of the Essencial cap (10k chunks × ~600 tok ≈ 6M tok) is a **one-time** embedding cost; the chunk cap + `syncIntervalHours` bound re-embedding; search is cheap (query embed + rerank over top_k). Record the numbers in the commit message. **If any plan's steady-state COGS exceeds its price, STOP and flag Bruno** (do not silently ship an unprofitable plan).

- [ ] **Step 6: Commit**

```bash
git add src/billing/usage.ts src/billing/__tests__/usage.test.ts
git commit -m "feat(billing): usage queries + quota asserts (owner-exempt) [COGS: <numbers>]"
```

---

# Phase B1 — Enforcement (freemium real)

> Isolation note: none of these tasks touch `buildFilterClauses` or the `account_id`+workspace SQL guard. They add a quota layer above it. **The existing isolation tests must stay green** — run the full suite at the end of each task.

## Task B1.1: `brain_search` monthly cap

**Files:**
- Modify: `src/rag/search.ts` (the `recordUsage(accountId, "search", 1)` site, ~line 265)
- Modify: `src/rag/brain-tool.ts`
- Test: `src/rag/__tests__/search.test.ts` (add a case) — or a new `src/billing/__tests__/search-enforce.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/search-enforce.test.ts`:

```ts
// src/billing/__tests__/search-enforce.test.ts
// brainSearch must throw QuotaExceededError for a friend over the monthly cap,
// and must NOT touch billing at all for the owner/default account.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../../context.js";
import { brainSearch } from "../../rag/search.js";
import { QuotaExceededError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string, searchSum: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/sum\(qty\)/i.test(sql)) return { rows: [{ total: String(searchSum) }] };
      // any other query (semantic/keyword) returns no rows
      return { rows: [] };
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("friend over the cap -> brainSearch throws QuotaExceededError before querying", async () => {
  __setPoolForTest(memPool("free", 100) as never);
  await requestContext.run(
    { authType: "bearer", scopes: "all", accountId: "friend:1" } as never,
    async () => {
      await assert.rejects(() => brainSearch("oi", { mode: "keyword", rerank: false }), QuotaExceededError);
    },
  );
});

test("owner/default account -> no billing query, search proceeds", async () => {
  // memPool would throw if a 'SELECT plan' ever ran (it won't for the default account)
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) throw new Error("must not check plan for owner");
      return { rows: [] };
    },
  } as never);
  // No accountId in context -> getAccountId() === DEFAULT_ACCOUNT_ID ('bruno')
  const hits = await brainSearch("oi", { mode: "keyword", rerank: false });
  assert.ok(Array.isArray(hits));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/billing/__tests__/search-enforce.test.ts`
Expected: FAIL — the friend case does NOT throw (no enforcement yet).

- [ ] **Step 3: Add the enforcement in `search.ts`**

In `src/rag/search.ts`, add the import near the existing `import { recordUsage } from "./usage.js";` (line ~15):

```ts
import { assertSearchWithinLimit } from "../billing/usage.js";
```

Then, in `brainSearch`, locate the passive-metering line:

```ts
  // F3.0 — passive metering (best-effort, never blocks the search).
  await recordUsage(accountId, "search", 1);
```

Insert the quota check **immediately before** it:

```ts
  // Fase 3 billing — hard-cap searches/month for non-owner accounts. Throws
  // QuotaExceededError (surfaced by the brain_search tool as a friendly message).
  // Owner/default account is exempt (no DB hit) so cron/eval/tests are unchanged.
  await assertSearchWithinLimit(accountId);

  // F3.0 — passive metering (best-effort, never blocks the search).
  await recordUsage(accountId, "search", 1);
```

- [ ] **Step 4: Surface the error nicely in `brain-tool.ts`**

In `src/rag/brain-tool.ts`, add the import after the existing imports:

```ts
import { QuotaExceededError } from "../billing/usage.js";
```

Replace the handler body's search call (currently `const hits = await brainSearch(...)`) with a try/catch:

```ts
    async (args) => {
      const filters = args.filters as SearchFilters | undefined;
      let hits;
      try {
        hits = await brainSearch(args.query, {
          topK: args.top_k,
          mode: args.mode,
          rerank: args.rerank,
          filters,
          includeNeighbors: args.include_neighbors,
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "quota_exceeded", message: e.message }, null, 2) },
            ],
          };
        }
        throw e;
      }
      return {
```

(Leave the rest of the `return { content: [...] }` block unchanged.)

- [ ] **Step 5: Run the new test + the existing search suite**

Run:
```bash
npx tsx --test src/billing/__tests__/search-enforce.test.ts
npx tsx --test src/rag/__tests__/search.test.ts
```
Expected: both PASS (existing search tests run as the default account and hit the exempt fast path).

- [ ] **Step 6: Commit**

```bash
git add src/rag/search.ts src/rag/brain-tool.ts src/billing/__tests__/search-enforce.test.ts
git commit -m "feat(billing): enforce brain_search monthly cap (owner-exempt)"
```

---

## Task B1.2: chunk-storage cap (defensive guard in `upsertChunks`)

This single guard covers **every** indexing path (background indexAccount passes, on-demand url/web tools, portal reindex) for the chunk cap. The owner/default account is exempt, so the hot owner cron pays nothing.

**Files:**
- Modify: `src/rag/storage.ts` (`upsertChunks`, lines 45-86)
- Test: `src/billing/__tests__/chunk-cap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/chunk-cap.test.ts`:

```ts
// src/billing/__tests__/chunk-cap.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { upsertChunks } from "../../rag/storage.js";
import { QuotaExceededError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";
import type { ChunkWithEmbedding } from "../../rag/types.js";

function chunk(id: string, accountId: string): ChunkWithEmbedding {
  return {
    id, source_type: "notion", source_id: "s", workspace: "personal",
    db_name: null, parent_url: null, chunk_index: 0, text: "t",
    embedding: Array.from({ length: 1024 }, () => 0.001),
    metadata: {}, source_updated: null, account_id: accountId,
  } as ChunkWithEmbedding;
}

function memPool(plan: string, chunkCount: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/count\(\*\)::text AS n FROM brain_chunks/i.test(sql)) return { rows: [{ n: String(chunkCount) }] };
      return { rows: [], rowCount: 0 }; // INSERTs
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("friend at chunk cap -> upsertChunks throws QuotaExceededError", async () => {
  __setPoolForTest(memPool("free", 2000) as never); // already at 2000 cap
  await assert.rejects(() => upsertChunks([chunk("a", "friend:1")]), QuotaExceededError);
});

test("owner/default account -> upsertChunks never checks the cap", async () => {
  __setPoolForTest({
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) throw new Error("must not check plan for owner");
      return { rows: [], rowCount: 0 };
    },
  } as never);
  await upsertChunks([chunk("a", "bruno")]); // no throw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/billing/__tests__/chunk-cap.test.ts`
Expected: FAIL — friend case does not throw.

- [ ] **Step 3: Add the guard to `upsertChunks`**

In `src/rag/storage.ts`, `upsertChunks` currently starts:

```ts
export async function upsertChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
  if (chunks.length === 0) return;
  const p = getPool();
```

Insert the cap guard right after `const p = getPool();`:

```ts
export async function upsertChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
  if (chunks.length === 0) return;
  const p = getPool();
  // Fase 3 billing — defensive chunk-storage cap. Owner/default account is
  // exempt (no DB hit). Lazy import to avoid the storage<->billing cycle (same
  // pattern as recordUsage). Throws QuotaExceededError when a friend would
  // exceed their plan's maxChunks; callers (indexAccount passes / on-demand
  // tools) record it as a failed run / return a friendly error.
  const acctForCap = chunks[0]?.account_id ?? getAccountId();
  if (acctForCap !== DEFAULT_ACCOUNT_ID) {
    const { assertChunksWithinLimit } = await import("../billing/usage.js");
    await assertChunksWithinLimit(acctForCap, chunks.length);
  }
```

(`getAccountId` and `DEFAULT_ACCOUNT_ID` are already imported at the top of `storage.ts`.)

- [ ] **Step 4: Run the new test + existing storage suite**

Run:
```bash
npx tsx --test src/billing/__tests__/chunk-cap.test.ts
npx tsx --test src/rag/__tests__/storage.test.ts
```
Expected: both PASS (existing storage tests upsert as the default account → exempt).

- [ ] **Step 5: Commit**

```bash
git add src/rag/storage.ts src/billing/__tests__/chunk-cap.test.ts
git commit -m "feat(billing): defensive chunk-storage cap in upsertChunks (owner-exempt)"
```

---

## Task B1.3: on-demand indexing — feature gate + daily cap + metering

**Files:**
- Modify: `src/rag/brain-index-url-tool.ts`
- Modify: `src/rag/brain-index-web-tool.ts`
- Test: `src/billing/__tests__/ondemand-enforce.test.ts`

- [ ] **Step 1: Write the failing test (web tool path, which we can drive directly)**

The url/web tools are MCP handlers; we test the enforcement helper wiring via the web tool's exported registration is awkward, so test the **gate helper contract** at the unit level here and rely on the manual/e2e check for the handler. Create `src/billing/__tests__/ondemand-enforce.test.ts`:

```ts
// src/billing/__tests__/ondemand-enforce.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string, used: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/sum\(qty\)/i.test(sql)) return { rows: [{ total: String(used) }] };
      return { rows: [] };
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("free plan -> on-demand always blocked", async () => {
  __setPoolForTest(memPool("free", 0) as never);
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 1), QuotaExceededError);
});

test("pro plan within daily cap -> allowed; over -> blocked", async () => {
  __setPoolForTest(memPool("pro", 190) as never);
  await assertOnDemandWithinLimit("friend:1", 10); // 200 ok
  __setPoolForTest(memPool("pro", 195) as never);
  __clearPlanCache();
  await assert.rejects(() => assertOnDemandWithinLimit("friend:1", 10), QuotaExceededError);
});
```

- [ ] **Step 2: Run test to verify it passes the helper** (the helper already exists from B0.5)

Run: `npx tsx --test src/billing/__tests__/ondemand-enforce.test.ts`
Expected: PASS (this locks the contract the handlers depend on).

- [ ] **Step 3: Wire the gate into `brain_index_url`**

In `src/rag/brain-index-url-tool.ts`, add imports near the top (after the existing imports):

```ts
import { getAccountId } from "../context.js";
import { recordUsage } from "./usage.js";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../billing/usage.js";
```

In the handler `async ({ workspace, url, max_pages }) => {`, right after `assertWorkspaceScope(workspace as Workspace);`, add the pre-check:

```ts
      assertWorkspaceScope(workspace as Workspace);

      // Fase 3 billing — on-demand indexing is gated by plan (Free = off) and a
      // daily page cap. Owner/default account is exempt. We pre-check against the
      // requested max_pages and record the ACTUAL pages indexed after success.
      const accountId = getAccountId();
      try {
        await assertOnDemandWithinLimit(accountId, max_pages);
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "quota_exceeded", message: e.message }) }] };
        }
        throw e;
      }
```

Then record the actual pages at each successful return. There are three:
- **page branch** (the `kind: "page"` return ~line 170): add before `return {`:
  ```ts
        const result = await indexSinglePage(ws, page, null);
        await recordUsage(accountId, "index_pages", 1);
        return {
  ```
- **data_source branch** (~line 209): after `const total_chunks = pages.reduce(...)`:
  ```ts
        const total_chunks = pages.reduce((sum, p) => sum + p.chunks, 0);
        await recordUsage(accountId, "index_pages", pages.length);
        return {
  ```
- **database branch** (~line 273): after its `const total_chunks = pages.reduce(...)`:
  ```ts
        const total_chunks = pages.reduce((sum, p) => sum + p.chunks, 0);
        await recordUsage(accountId, "index_pages", pages.length);
        return {
  ```

- [ ] **Step 4: Wire the gate into `brain_index_web`**

In `src/rag/brain-index-web-tool.ts`, add imports near the top:

```ts
import { recordUsage } from "./usage.js";
import { assertOnDemandWithinLimit, QuotaExceededError } from "../billing/usage.js";
```

In the handler (which already does `const accountId = getAccountId();` after `assertWorkspaceScope`), add the gate right after `assertWorkspaceScope(workspace as Workspace);` and the existing `const accountId = getAccountId();`:

```ts
      assertWorkspaceScope(workspace as Workspace);

      try {
        const accountId = getAccountId();
        await assertOnDemandWithinLimit(accountId, 1);
        const doc = await fetchWebDocument(url, { workspace: workspace as Workspace });
```

(The handler already has a surrounding `try { ... } catch (e: any)`. Add a `QuotaExceededError` branch in that existing catch so the message is friendly, e.g. `if (e instanceof QuotaExceededError) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "quota_exceeded", message: e.message }) }] };` at the top of the catch.) After the existing `await upsertChunks(chunks);`, add:

```ts
        await upsertChunks(chunks);
        await recordUsage(accountId, "index_pages", 1);
```

- [ ] **Step 5: Build to confirm types compile**

Run: `npm run build`
Expected: PASS (no TS errors). Then `npx tsx --test src/billing/__tests__/ondemand-enforce.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rag/brain-index-url-tool.ts src/rag/brain-index-web-tool.ts src/billing/__tests__/ondemand-enforce.test.ts
git commit -m "feat(billing): gate on-demand indexing by plan (feature + daily cap) + meter index_pages"
```

---

## Task B1.4: workspace-count cap on Notion connect

**Files:**
- Modify: `src/portal/routes.ts` (`POST /portal/notion/pat` ~281, `GET /portal/notion/connect` ~295)
- Test: `src/billing/__tests__/workspace-cap.test.ts` (helper-level) + manual check

- [ ] **Step 1: Add a small shared helper test**

Create `src/billing/__tests__/workspace-cap.test.ts`:

```ts
// src/billing/__tests__/workspace-cap.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertCanAddWorkspace, WorkspaceLimitError } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string, wsCount: number) {
  return {
    query: async (sql: string) => {
      if (/SELECT plan FROM account/i.test(sql)) return { rows: [{ plan }] };
      if (/count\(\*\)::text AS n FROM account_workspaces/i.test(sql)) return { rows: [{ n: String(wsCount) }] };
      return { rows: [] };
    },
  };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("free (1 ws) -> second workspace blocked", async () => {
  __setPoolForTest(memPool("free", 1) as never);
  await assert.rejects(() => assertCanAddWorkspace("friend:1"), WorkspaceLimitError);
});

test("pro (3 ws) -> third allowed, fourth blocked", async () => {
  __setPoolForTest(memPool("pro", 2) as never);
  await assertCanAddWorkspace("friend:1"); // 3rd ok
  __setPoolForTest(memPool("pro", 3) as never); __clearPlanCache();
  await assert.rejects(() => assertCanAddWorkspace("friend:1"), WorkspaceLimitError);
});

test("owner/default exempt", async () => {
  __setPoolForTest({ query: async () => { throw new Error("no check"); } } as never);
  await assertCanAddWorkspace("bruno");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/billing/__tests__/workspace-cap.test.ts`
Expected: FAIL — `assertCanAddWorkspace` / `WorkspaceLimitError` not exported.

- [ ] **Step 3: Add `assertCanAddWorkspace` + `WorkspaceLimitError` to `src/billing/usage.ts`**

Append to `src/billing/usage.ts`:

```ts
export class WorkspaceLimitError extends Error {
  constructor(public readonly limit: number, public readonly current: number) {
    super(`Limite de workspaces do plano atingido (${current}/${limit}). Faça upgrade em zinom.ai/app.html para conectar mais.`);
    this.name = "WorkspaceLimitError";
  }
}

async function countWorkspaces(accountId: string): Promise<number> {
  if (!process.env.POSTGRES_URL && !hasInjectedPool()) return 0;
  const p = getPool();
  const { rows } = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM account_workspaces WHERE account_id=$1`,
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Throws WorkspaceLimitError if the account is already at its plan's
 *  maxWorkspaces. Owner/default exempt. Call BEFORE associating a new workspace. */
export async function assertCanAddWorkspace(accountId: string): Promise<void> {
  if (accountId === DEFAULT_ACCOUNT_ID) return;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return;
  const limits = getPlanLimits(plan);
  const current = await countWorkspaces(accountId);
  if (current >= limits.maxWorkspaces) {
    throw new WorkspaceLimitError(limits.maxWorkspaces, current);
  }
}
```

- [ ] **Step 4: Gate the two portal connect routes**

In `src/portal/routes.ts`, add the import at the top with the other billing-free imports:

```ts
import { assertCanAddWorkspace, WorkspaceLimitError } from "../billing/usage.js";
```

In `POST /portal/notion/pat`, wrap the association. Replace the `try { ... }` body's start:

```ts
  router.post("/portal/notion/pat", requireSession, async (req, res) => {
    const pat = typeof req.body?.pat === "string" ? req.body.pat.trim() : "";
    if (!pat) {
      res.status(400).json({ error: "cole um Personal Access Token" });
      return;
    }
    try {
      await assertCanAddWorkspace(res.locals.accountId);
      const { validatePat, associatePatToAccount } = await import("../notion-oauth.js");
      const identity = await validatePat(pat);
      await associatePatToAccount(res.locals.accountId, pat, identity);
      res.json({ ok: true, name: identity.name });
    } catch (err: any) {
      if (err instanceof WorkspaceLimitError) {
        res.status(402).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err?.message ?? "token inválido" });
    }
  });
```

In `GET /portal/notion/connect`, add the check before building the authorize URL:

```ts
  router.get("/portal/notion/connect", requireSession, async (_req, res) => {
    if (!notionClientId) {
      res.status(503).json({ error: "Notion OAuth não configurado" });
      return;
    }
    try {
      await assertCanAddWorkspace(res.locals.accountId);
    } catch (err: any) {
      if (err instanceof WorkspaceLimitError) {
        res.status(402).json({ error: err.message });
        return;
      }
      throw err;
    }
    const { buildAuthorizeUrl } = await import("../notion-oauth.js");
```

(Leave the rest of the handler unchanged.) Note: the standalone (non-portal) `/notion/callback` onboarding path creates a brand-new account and is out of scope here — friends connect additional workspaces through these two portal routes.

- [ ] **Step 5: Verify**

Run:
```bash
npx tsx --test src/billing/__tests__/workspace-cap.test.ts
npm run build
```
Expected: test PASS, build PASS.

- [ ] **Step 6: Commit**

```bash
git add src/billing/usage.ts src/portal/routes.ts src/billing/__tests__/workspace-cap.test.ts
git commit -m "feat(billing): cap connected Notion workspaces per plan (owner-exempt)"
```

---

## Task B1.5: feature-gate Granola + Calendar passes by plan

**Files:**
- Modify: `src/rag/index-account.ts` (`indexAccount`, the Granola pass ~and the iCal pass)
- Test: `src/billing/__tests__/feature-gate.test.ts`

- [ ] **Step 1: Write the failing test**

`indexAccount` does heavy I/O, so test the **gate decision** via a tiny exported predicate. Create `src/billing/__tests__/feature-gate.test.ts`:

```ts
// src/billing/__tests__/feature-gate.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { accountHasFeature } from "../usage.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

function memPool(plan: string) {
  return { query: async (sql: string) => (/SELECT plan FROM account/i.test(sql) ? { rows: [{ plan }] } : { rows: [] }) };
}

beforeEach(() => __clearPlanCache());
afterEach(() => { __setPoolForTest(null); __clearPlanCache(); });

test("free has no granolaCalendar; essencial does", async () => {
  __setPoolForTest(memPool("free") as never);
  assert.equal(await accountHasFeature("friend:1", "granolaCalendar"), false);
  __setPoolForTest(memPool("essencial") as never); __clearPlanCache();
  assert.equal(await accountHasFeature("friend:1", "granolaCalendar"), true);
});

test("classifierRevisitar/briefing only pro+", async () => {
  __setPoolForTest(memPool("essencial") as never);
  assert.equal(await accountHasFeature("friend:1", "classifierRevisitar"), false);
  __setPoolForTest(memPool("pro") as never); __clearPlanCache();
  assert.equal(await accountHasFeature("friend:1", "briefing"), true);
});

test("owner default account has everything", async () => {
  __setPoolForTest({ query: async () => { throw new Error("no check"); } } as never);
  assert.equal(await accountHasFeature("bruno", "granolaCalendar"), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/billing/__tests__/feature-gate.test.ts`
Expected: FAIL — `accountHasFeature` not exported.

- [ ] **Step 3: Add `accountHasFeature` to `src/billing/usage.ts`**

Append:

```ts
import type { PlanFeatures } from "./plans.js";

/** True if the account's plan includes a feature. Owner/default has all. */
export async function accountHasFeature(accountId: string, feature: keyof PlanFeatures): Promise<boolean> {
  if (accountId === DEFAULT_ACCOUNT_ID) return true;
  const plan = await getAccountPlan(accountId);
  if (isUnlimited(plan)) return true;
  return getPlanLimits(plan).features[feature];
}
```

(Move the `import type { PlanFeatures }` up next to the existing `import { getPlanLimits, isUnlimited } from "./plans.js";` — combine as `import { getPlanLimits, isUnlimited, type PlanFeatures } from "./plans.js";`.)

- [ ] **Step 4: Gate the passes in `index-account.ts`**

In `src/rag/index-account.ts`, add the import at the top:

```ts
import { accountHasFeature } from "../billing/usage.js";
```

In `indexAccount`, after `const workspaces = await warmAccount(accountId);`, compute the gate once:

```ts
  const workspaces = await warmAccount(accountId);
  const canGranolaCalendar = await accountHasFeature(accountId, "granolaCalendar");
  let documents = 0;
  let chunks = 0;
```

Then guard the Granola pass — change:

```ts
  const granolaKey = await getAccountSecret(accountId, "granola");
  if (granolaKey) {
```
to:
```ts
  const granolaKey = canGranolaCalendar ? await getAccountSecret(accountId, "granola") : null;
  if (granolaKey) {
```

And guard the iCal pass — change:

```ts
  const icalConfigs = accountIcalConfigs(await getAccountSecret(accountId, "ical"));
  if (icalConfigs.length > 0) {
```
to:
```ts
  const icalConfigs = canGranolaCalendar ? accountIcalConfigs(await getAccountSecret(accountId, "ical")) : [];
  if (icalConfigs.length > 0) {
```

(The Notion pass always runs — every plan indexes Notion.)

- [ ] **Step 5: Verify build + the new test**

Run:
```bash
npx tsx --test src/billing/__tests__/feature-gate.test.ts
npm run build
```
Expected: PASS / PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rag/index-account.ts src/billing/usage.ts src/billing/__tests__/feature-gate.test.ts
git commit -m "feat(billing): feature-gate Granola+Calendar indexing by plan"
```

> **Scope note (record in commit body):** Classifier / Revisitar / Briefing are currently **owner-only** (hard-coded personal-workspace DB ids) and do not run per friend account yet. Their plan flags (`classifierRevisitar`, `briefing`) now exist and are enforced where a per-account version would hook in, but **building per-account classifier/briefing is out of scope for billing** (separate feature). Today those flags gate nothing for friends because the feature isn't per-account; they are ready for when it is.

---

## Task B1.6: per-account auto re-sync cron (frescor lever)

No per-account background indexer exists today (`runDeltaSync` is Bruno's fixed workspaces; `indexAccount` is event-driven only). This adds a small loop that re-indexes active friend accounts on their plan's cadence. Free = manual only (skipped).

**Files:**
- Create: `src/billing/resync-cron.ts`
- Modify: `src/index-classifier.ts` (schedule it)
- Test: `src/billing/__tests__/resync-cron.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/resync-cron.test.ts`:

```ts
// src/billing/__tests__/resync-cron.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dueAccounts, runResyncTick } from "../resync-cron.js";
import { __setPoolForTest } from "../../rag/storage.js";

interface Row { id: string; plan: string; last_run: Date | null }

function memPool(rows: Row[]) {
  return {
    query: async (sql: string) => {
      if (/FROM account a/i.test(sql)) {
        return { rows: rows.map((r) => ({ id: r.id, plan: r.plan, last_run: r.last_run })) };
      }
      return { rows: [] };
    },
  };
}

const NOW = new Date("2026-06-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

beforeEach(() => {});
afterEach(() => __setPoolForTest(null));

test("dueAccounts: free skipped; paid due iff older than interval", async () => {
  __setPoolForTest(memPool([
    { id: "f:free", plan: "free", last_run: hoursAgo(999) },     // free -> never
    { id: "f:ess", plan: "essencial", last_run: hoursAgo(25) },  // 24h interval -> due
    { id: "f:ess2", plan: "essencial", last_run: hoursAgo(2) },  // not due
    { id: "f:pro", plan: "pro", last_run: null },                // never indexed -> due
    { id: "f:ili", plan: "ilimitado", last_run: hoursAgo(0.5) }, // 1h interval -> not due
  ]) as never);
  const due = await dueAccounts(NOW);
  assert.deepEqual(due.sort(), ["f:ess", "f:pro"]);
});

test("runResyncTick calls the injected indexer for each due account", async () => {
  __setPoolForTest(memPool([
    { id: "f:pro", plan: "pro", last_run: hoursAgo(7) }, // 6h interval -> due
  ]) as never);
  const called: string[] = [];
  await runResyncTick(NOW, async (id) => { called.push(id); });
  assert.deepEqual(called, ["f:pro"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/billing/__tests__/resync-cron.test.ts`
Expected: FAIL — `Cannot find module '../resync-cron.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/billing/resync-cron.ts`:

```ts
// src/billing/resync-cron.ts
// Per-account auto re-sync (the "frescor" plan lever). Free accounts re-index
// only manually (portal button); paid plans get a cadence (syncIntervalHours).
// This is the ONLY background loop that fans out over accounts; it reuses the
// event-driven indexAccount() as the per-account entry point.
import { getPool } from "../rag/storage.js";
import { getPlanLimits } from "./plans.js";

interface AccountAge { id: string; plan: string; last_run: Date | null }

/** Active friend accounts + their most-recent indexer run time. */
async function activeAccountAges(): Promise<AccountAge[]> {
  const p = getPool();
  const { rows } = await p.query<AccountAge>(
    `SELECT a.id, a.plan,
            (SELECT max(ended_at) FROM status_runs s
              WHERE s.account_id = a.id AND s.worker = 'indexer') AS last_run
       FROM account a
      WHERE a.status = 'active' AND a.kind = 'friend'`,
  );
  return rows;
}

/** Account ids whose plan has an auto-resync interval and whose last run is older
 *  than that interval (or never ran). Free (syncIntervalHours = null) is skipped. */
export async function dueAccounts(now: Date = new Date()): Promise<string[]> {
  const ages = await activeAccountAges();
  const due: string[] = [];
  for (const a of ages) {
    const interval = getPlanLimits(a.plan).syncIntervalHours;
    if (interval == null) continue; // free / manual only
    if (a.last_run == null) { due.push(a.id); continue; }
    const ageHours = (now.getTime() - new Date(a.last_run).getTime()) / 3600_000;
    if (ageHours >= interval) due.push(a.id);
  }
  return due;
}

/** Re-index every due account sequentially (cheap fan-out; one VPS). The indexer
 *  is injected for tests; defaults to the real per-account indexAccount. */
export async function runResyncTick(
  now: Date = new Date(),
  indexFn?: (accountId: string) => Promise<unknown>,
): Promise<{ ran: string[] }> {
  const fn = indexFn ?? (async (id: string) => {
    const { indexAccount } = await import("../rag/index-account.js");
    return indexAccount(id);
  });
  const due = await dueAccounts(now);
  const ran: string[] = [];
  for (const id of due) {
    try {
      await fn(id);
      ran.push(id);
    } catch (err: any) {
      console.error(`[resync] account=${id} failed: ${err?.message ?? err}`);
    }
  }
  if (ran.length) console.log(`[resync] re-indexed ${ran.length} account(s): ${ran.join(", ")}`);
  return { ran };
}
```

- [ ] **Step 4: Schedule it in the classifier process**

In `src/index-classifier.ts`, add near the other cron schedules. First the import at the top:

```ts
import { runResyncTick } from "./billing/resync-cron.js";
```

Then add a schedule (hourly is the finest plan cadence, so an hourly tick honors every interval). Add after the existing `cron.schedule(...)` calls:

```ts
// Fase 3 billing — per-account auto re-sync. Hourly tick; each account is
// re-indexed only when its plan's syncIntervalHours has elapsed (free skipped).
const RESYNC_CRON = process.env.RESYNC_CRON ?? "15 * * * *";
cron.schedule(RESYNC_CRON, () => {
  void runResyncTick().catch((err) => console.error("[resync] tick failed", err));
});
console.log(`[classifier] account resync scheduled: ${RESYNC_CRON}`);
```

- [ ] **Step 5: Verify**

Run:
```bash
npx tsx --test src/billing/__tests__/resync-cron.test.ts
npm run build
```
Expected: PASS / PASS.

- [ ] **Step 6: Commit**

```bash
git add src/billing/resync-cron.ts src/index-classifier.ts src/billing/__tests__/resync-cron.test.ts
git commit -m "feat(billing): per-account auto re-sync cron honoring plan frescor (free=manual)"
```

---

## Task B1.7: full suite + isolation regression gate

- [ ] **Step 1: Run the entire suite**

Run: `npm test`
Expected: ALL PASS, including the existing isolation tests (`storage.test.ts`, `search.test.ts`, `getAllowedWorkspaces.test.ts`). If anything regressed, fix before proceeding — isolation must not regress.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add -A && git commit -m "test(billing): full suite green incl. isolation (no regression)"
```

---

# Phase B2 — Stripe (hosted, production)

## Task B2.1: `src/billing/stripe.ts` — lazy client

**Files:**
- Create: `src/billing/stripe.ts`
- Test: `src/billing/__tests__/stripe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/stripe.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/billing/__tests__/stripe.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `src/billing/stripe.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/billing/__tests__/stripe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/billing/stripe.ts src/billing/__tests__/stripe.test.ts
git commit -m "feat(billing): lazy Stripe client (env key, SDK-pinned apiVersion)"
```

---

## Task B2.2: webhook handler + router (signature + idempotency)

**Files:**
- Create: `src/billing/webhook.ts`
- Test: `src/billing/__tests__/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/billing/__tests__/webhook.test.ts`:

```ts
// src/billing/__tests__/webhook.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleStripeEvent } from "../webhook.js";
import { __clearPlanCache } from "../account-plan.js";
import { __setPoolForTest } from "../../rag/storage.js";

interface Acct { id: string; plan: string; plan_status: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end: Date | null }
let accounts: Map<string, Acct>;

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
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
  accounts = new Map([["friend:1", { id: "friend:1", plan: "free", plan_status: null, stripe_customer_id: "cus_1", stripe_subscription_id: null, current_period_end: null }]]);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/billing/__tests__/webhook.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `src/billing/webhook.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/billing/__tests__/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/billing/webhook.ts src/billing/__tests__/webhook.test.ts
git commit -m "feat(billing): Stripe webhook handler + router (signature + idempotency)"
```

---

## Task B2.3: mount the webhook before `express.json()`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the import**

In `src/index.ts`, with the other router imports, add:

```ts
import { createStripeWebhookRouter } from "./billing/webhook.js";
```

- [ ] **Step 2: Mount BEFORE the body parsers**

Locate (around line 163-166):

```ts
app.use("/notion", oauthLimiter);

// Parse JSON for all routes, URL-encoded for OAuth consent form
app.use(express.json());
```

Insert the webhook router between them so it gets the raw body:

```ts
app.use("/notion", oauthLimiter);

// Fase 3 billing — Stripe webhook MUST be mounted before express.json() so its
// per-route express.raw() sees the exact bytes for signature verification.
app.use(createStripeWebhookRouter());

// Parse JSON for all routes, URL-encoded for OAuth consent form
app.use(express.json());
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 4: Manual smoke (optional, local)**

With `STRIPE_WEBHOOK_SECRET` unset, `POST /webhooks/stripe` returns `503`. (Full signed delivery is verified in B4 via the Stripe CLI.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(billing): mount Stripe webhook router before express.json()"
```

---

## Task B2.4: billing API routes in the portal (checkout / manage / status)

**Files:**
- Modify: `src/portal/routes.ts` (inside `createPortalRouter`, in the session-required section)

- [ ] **Step 1: Add imports**

At the top of `src/portal/routes.ts`, add:

```ts
import { PAID_PLANS, priceIdForPlan, getPlanLimits, type PlanId } from "../billing/plans.js";
import { getBillingRow, setStripeCustomerId } from "../billing/account-plan.js";
import { getUsageSnapshot } from "../billing/usage.js";
import { getStripe } from "../billing/stripe.js";
```

- [ ] **Step 2: Add the three routes**

In `createPortalRouter`, in the session-required block (after `POST /portal/mcp-token`), add:

```ts
  const APP_URL = process.env.BASE_URL ?? "https://zinom.ai";

  // Current plan + usage snapshot + purchasable plans (for the "Plano & Uso" UI).
  router.get("/portal/billing", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const usage = await getUsageSnapshot(accountId);
      const row = await getBillingRow(accountId);
      res.json({
        plan: usage.plan,
        plan_status: row?.plan_status ?? null,
        current_period_end: row?.current_period_end ?? null,
        manage_available: Boolean(row?.stripe_customer_id),
        usage,
        plans: PAID_PLANS.map((id) => {
          const l = getPlanLimits(id);
          return {
            id, label: l.label, priceBRLCents: l.priceBRLCents,
            maxWorkspaces: l.maxWorkspaces, maxChunks: l.maxChunks,
            searchesPerMonth: l.searchesPerMonth, onDemandPagesPerDay: l.onDemandPagesPerDay,
            features: l.features,
          };
        }),
      });
    } catch (err: any) {
      console.error(`[portal] /billing: ${err?.message ?? err}`);
      res.status(500).json({ error: "erro ao carregar plano" });
    }
  });

  // Start a hosted Checkout for an upgrade. Returns { url } for the front to redirect to.
  router.post("/portal/billing/checkout", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const plan = String(req.body?.plan ?? "") as PlanId;
    if (!PAID_PLANS.includes(plan)) { res.status(400).json({ error: "plano inválido" }); return; }
    const price = priceIdForPlan(plan);
    if (!price) { res.status(503).json({ error: "billing não configurado" }); return; }
    try {
      const stripe = getStripe();
      const row = await getBillingRow(accountId);
      let customerId = row?.stripe_customer_id ?? null;
      if (!customerId) {
        const email = await getAccountEmail(accountId).catch(() => null);
        const customer = await stripe.customers.create({ email: email ?? undefined, metadata: { account_id: accountId } });
        customerId = customer.id;
        await setStripeCustomerId(accountId, customerId);
      }
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: accountId,
        line_items: [{ price, quantity: 1 }],
        success_url: `${APP_URL}/app.html?billing=success`,
        cancel_url: `${APP_URL}/app.html?billing=cancel`,
        metadata: { account_id: accountId },
        subscription_data: { metadata: { account_id: accountId } },
      });
      res.json({ url: session.url });
    } catch (err: any) {
      console.error(`[portal] checkout: ${err?.message ?? err}`);
      res.status(502).json({ error: "falha ao iniciar checkout" });
    }
  });

  // Open the Stripe-hosted Customer Portal (change card, switch/cancel plan).
  router.post("/portal/billing/manage", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const row = await getBillingRow(accountId);
      if (!row?.stripe_customer_id) { res.status(400).json({ error: "sem assinatura ativa" }); return; }
      const stripe = getStripe();
      const session = await stripe.billingPortal.sessions.create({
        customer: row.stripe_customer_id,
        return_url: `${APP_URL}/app.html`,
      });
      res.json({ url: session.url });
    } catch (err: any) {
      console.error(`[portal] manage: ${err?.message ?? err}`);
      res.status(502).json({ error: "falha ao abrir portal de assinatura" });
    }
  });
```

(`getAccountEmail` and `requireSession` already exist in this file from the portal. `req.body` is available because the portal runs after `express.json()`.)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/portal/routes.ts
git commit -m "feat(billing): portal checkout/manage/billing-status routes (hosted Stripe)"
```

---

## Task B2.5: `scripts/stripe-setup-prices.mts` — provision products/prices

**Files:**
- Create: `scripts/stripe-setup-prices.mts`

- [ ] **Step 1: Write the script**

Create `scripts/stripe-setup-prices.mts`:

```ts
// scripts/stripe-setup-prices.mts
// One-shot, idempotent: create the 3 paid Products + monthly BRL Prices in the
// Stripe account and print the price ids to put in .env. Idempotent by
// metadata.zinom_plan: re-running finds the existing product and reuses an
// active monthly BRL price (creates one only if missing). Creates REAL objects
// in whatever account STRIPE_SECRET_KEY points to — run with Bruno's ok.
//   STRIPE_SECRET_KEY=sk_... npm run stripe:prices
import "dotenv/config";
import Stripe from "stripe";
import { PLANS, PAID_PLANS } from "../src/billing/plans.js";

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set");
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function findProduct(zinomPlan: string): Promise<Stripe.Product | null> {
  const res = await stripe.products.search({ query: `metadata['zinom_plan']:'${zinomPlan}'` });
  return res.data[0] ?? null;
}

async function ensureProduct(zinomPlan: string, name: string): Promise<Stripe.Product> {
  return (await findProduct(zinomPlan)) ?? (await stripe.products.create({
    name, metadata: { zinom_plan: zinomPlan },
  }));
}

async function ensurePrice(product: Stripe.Product, amountCents: number): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = prices.data.find(
    (p) => p.currency === "brl" && p.recurring?.interval === "month" && p.unit_amount === amountCents,
  );
  return match ?? (await stripe.prices.create({
    product: product.id, currency: "brl", unit_amount: amountCents, recurring: { interval: "month" },
  }));
}

async function main(): Promise<void> {
  const envLines: string[] = [];
  for (const id of PAID_PLANS) {
    const plan = PLANS[id];
    const product = await ensureProduct(id, `Zinom ${plan.label}`);
    const price = await ensurePrice(product, plan.priceBRLCents);
    const envKey = `STRIPE_PRICE_${id.toUpperCase()}`;
    envLines.push(`${envKey}=${price.id}`);
    console.log(`  ${plan.label.padEnd(10)} product=${product.id} price=${price.id} (R$${(plan.priceBRLCents / 100).toFixed(2)}/mês)`);
  }
  console.log("");
  console.log("  Cole no .env da VPS:");
  console.log("");
  for (const line of envLines) console.log(`    ${line}`);
  console.log("");
}

await main();
```

- [ ] **Step 2: Verify it compiles (dry, no real call)**

Run: `npm run build`
Expected: no TS errors. (Do NOT run `npm run stripe:prices` here — it creates real Stripe objects; that happens in B4 with Bruno's ok.)

- [ ] **Step 3: Commit**

```bash
git add scripts/stripe-setup-prices.mts
git commit -m "feat(billing): idempotent stripe-setup-prices script (BRL monthly)"
```

---

# Phase B3 — UI (app + admin)

## Task B3.1: "Plano & Uso" card in the app

**Files:**
- Modify: `portal/app.html`
- Modify: `portal/app.js`
- Modify: `portal/styles.css`

- [ ] **Step 1: Add the card markup to `portal/app.html`**

Inside the signed-in dashboard, add a new section (place it near the sources/MCP sections):

```html
    <section class="card" id="billing-card">
      <h2>Plano &amp; Uso</h2>
      <p id="billing-plan" class="muted">Carregando…</p>
      <div id="billing-meters"></div>
      <div id="billing-actions" class="row"></div>
      <p id="billing-msg" class="muted"></p>
    </section>
```

- [ ] **Step 2: Add the rendering logic to `portal/app.js`**

Add a loader + renderer and call it on page load (alongside the existing `/portal/me` load):

```js
function meterRow(label, used, limit) {
  const unlimited = !isFinite(limit) || limit === null;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const cls = pct >= 100 ? "meter-bar over" : pct >= 80 ? "meter-bar warn" : "meter-bar";
  const text = unlimited ? `${used} / ilimitado` : `${used} / ${limit}`;
  return `<div class="meter">
    <div class="meter-head"><span>${label}</span><span>${text}</span></div>
    <div class="meter-track"><div class="${cls}" style="width:${pct}%"></div></div>
  </div>`;
}

async function loadBilling() {
  const planEl = document.getElementById("billing-plan");
  const metersEl = document.getElementById("billing-meters");
  const actionsEl = document.getElementById("billing-actions");
  try {
    const r = await fetch("/portal/billing", { credentials: "same-origin" });
    if (!r.ok) throw new Error("falha");
    const b = await r.json();
    const labelMap = { free: "Free", essencial: "Essencial", pro: "Pro", ilimitado: "Ilimitado", owner: "Owner" };
    const status = b.plan_status && b.plan_status !== "active" ? ` (${b.plan_status})` : "";
    planEl.textContent = `Plano atual: ${labelMap[b.plan] ?? b.plan}${status}`;
    metersEl.innerHTML =
      meterRow("Chunks indexados", b.usage.chunks.used, b.usage.chunks.limit) +
      meterRow("Buscas no mês", b.usage.searches.used, b.usage.searches.limit) +
      meterRow("Páginas on-demand (hoje)", b.usage.onDemand.used, b.usage.onDemand.limit);

    const buttons = [];
    for (const p of b.plans) {
      if (p.id === b.plan) continue;
      buttons.push(`<button class="btn upgrade" data-plan="${p.id}">${p.label} — R$${(p.priceBRLCents / 100).toFixed(2)}/mês</button>`);
    }
    if (b.manage_available) buttons.push(`<button class="btn ghost" id="manage-sub">Gerenciar assinatura</button>`);
    actionsEl.innerHTML = buttons.join(" ");

    actionsEl.querySelectorAll(".upgrade").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const resp = await fetch("/portal/billing/checkout", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: btn.dataset.plan }),
        });
        const data = await resp.json();
        if (data.url) { window.location.href = data.url; }
        else { document.getElementById("billing-msg").textContent = data.error ?? "falha"; btn.disabled = false; }
      });
    });
    const manage = document.getElementById("manage-sub");
    if (manage) manage.addEventListener("click", async () => {
      manage.disabled = true;
      const resp = await fetch("/portal/billing/manage", { method: "POST", credentials: "same-origin" });
      const data = await resp.json();
      if (data.url) { window.location.href = data.url; }
      else { document.getElementById("billing-msg").textContent = data.error ?? "falha"; manage.disabled = false; }
    });
  } catch {
    planEl.textContent = "Não foi possível carregar o plano.";
  }
}

// Call on load (next to the existing /portal/me loader):
loadBilling();
```

- [ ] **Step 3: Add meter styles to `portal/styles.css`**

Append (keep the existing green `#1f8b4c` theme):

```css
.meter { margin: 10px 0; }
.meter-head { display: flex; justify-content: space-between; font-size: 13px; color: #ccc; margin-bottom: 4px; }
.meter-track { height: 8px; background: #20242d; border-radius: 999px; overflow: hidden; }
.meter-bar { height: 100%; background: #1f8b4c; border-radius: 999px; transition: width .3s; }
.meter-bar.warn { background: #d9a521; }
.meter-bar.over { background: #d64545; }
.btn.upgrade { background: #1f8b4c; }
.btn.ghost { background: transparent; border: 1px solid #3a3f4a; }
#billing-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
```

- [ ] **Step 4: Manual verification (light dev portal)**

Run a local Postgres seeded with `scripts/portal-dev-schema.sql`, then:
```bash
npm run dev:portal
```
Sign in (the dev server logs the magic link), open `/app.html`, and confirm the "Plano & Uso" card renders the plan + three meters + upgrade buttons. (Checkout redirect needs Stripe env, exercised in B4.)

- [ ] **Step 5: Commit**

```bash
git add portal/app.html portal/app.js portal/styles.css
git commit -m "feat(billing): Plano & Uso card in the app (plan, meters, upgrade/manage)"
```

---

## Task B3.2: admin — plan columns + MRR

**Files:**
- Modify: `src/admin/routes.ts`

- [ ] **Step 1: Include plan fields in the accounts query**

In `src/admin/routes.ts`, extend the `AccountRow` interface and the first query in `gather()`:

```ts
interface AccountRow {
  id: string;
  kind: string | null;
  email: string | null;
  status: string | null;
  created_at: Date;
  plan: string | null;
  plan_status: string | null;
  current_period_end: Date | null;
}
```

Change the first `Promise.all` query from:
```ts
    p.query<AccountRow>(`SELECT id, kind, email, status, created_at FROM account ORDER BY created_at`),
```
to:
```ts
    p.query<AccountRow>(`SELECT id, kind, email, status, created_at, plan, plan_status, current_period_end FROM account ORDER BY created_at`),
```

- [ ] **Step 2: Add an MRR card + plan column**

In `renderHtml`, after computing `friends`, add MRR (BRL cents per paid plan):

```ts
  const PLAN_CENTS: Record<string, number> = { essencial: 499, pro: 999, ilimitado: 1899 };
  const mrrCents = data.accounts.reduce(
    (sum, a) => sum + (a.plan_status === "active" || a.plan === "essencial" || a.plan === "pro" || a.plan === "ilimitado" ? (PLAN_CENTS[a.plan ?? ""] ?? 0) : 0),
    0,
  );
  const mrr = `R$${(mrrCents / 100).toFixed(2)}`;
```

Add a card to the `.cards` block:
```ts
  <div class="card"><div class="n">${mrr}</div><div class="l">MRR (aprox.)</div></div>
```

Add a `plano` column to the accounts table header (after `tipo`):
```ts
    <th>account_id</th><th>email</th><th>tipo</th><th>plano</th><th>fontes</th><th>MCP</th>
```

And in each account row (after the `kind` cell):
```ts
        <td>${escapeHtml(a.plan ?? "free")}${a.plan_status && a.plan_status !== "active" ? ` <span class="tag">${escapeHtml(a.plan_status)}</span>` : ""}</td>
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/admin/routes.ts
git commit -m "feat(billing): admin shows plan/status per account + approx MRR"
```

---

## Task B3.3: full suite + build, final green

- [ ] **Step 1:** Run `npm test` → ALL PASS (incl. isolation).
- [ ] **Step 2:** Run `npm run build` → no TS errors.
- [ ] **Step 3:** Run `npm run doctor` (if it needs a DB, run where one is available) → green.
- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "test(billing): full suite + build green before go-live"
```

---

# Phase B4 — Go-live (HOLD for Bruno's explicit ok)

> **Deploy gate (inegociável):** the isolation-path touches (storage/search) and the **live Stripe key** go to prod only after Bruno's explicit ok. Build, test, adversarial isolation+security review, CI green first. This phase is a runbook, not TDD.

- [ ] **Step 1: Adversarial review** — dispatch isolation + security reviewers over the diff (focus: no `account_id` regression, webhook signature + idempotency, no secret committed, plan never from input). Fix findings.
- [ ] **Step 2: Merge to `dev`, open PR `dev` → `main`** with CI green. Hold merge to `main` for Bruno.
- [ ] **Step 3: Backup the VPS Postgres** (`pg_dump`) before migrating.
- [ ] **Step 4: Apply migration on the VPS**: `npm run migrate` (verify 0009 applied; `bruno` → `plan='owner'`; existing friends → `free`).
- [ ] **Step 5: Provision Stripe prices**: `STRIPE_SECRET_KEY=<live> npm run stripe:prices`; paste `STRIPE_PRICE_*` into the VPS `.env`.
- [ ] **Step 6: Set VPS `.env`** (never committed): `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ESSENCIAL/_PRO/_ILIMITADO`, confirm `BASE_URL=https://zinom.ai`.
- [ ] **Step 7: Register the webhook** in the Stripe Dashboard → endpoint `https://zinom.ai/webhooks/stripe`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- [ ] **Step 8: Restart** the PM2 processes (`notion-mcp` + `brain-classifier` for the resync cron).
- [ ] **Step 9: Smoke test (real R$, with Bruno)** — a friend account upgrades via Checkout (a real low-value transaction or a 100%-off coupon), confirm the webhook flips `plan`, the app shows the new plan + raised limits, and the admin MRR updates. Then cancel via the Customer Portal and confirm it returns to `free` at period end.
- [ ] **Step 10: Update CLAUDE.md / RUNBOOK** with the billing env vars + the resync cron, and update memory.

---

## Self-Review (run before handing to execution)

**Spec coverage:** C1 BRL (prices in cents, currency `brl`) ✓ B2.5. C2 matrix ✓ B0.3. C3 Stripe hosted prod (Checkout/Portal/webhook; dev uses mock/injected client) ✓ B2. C4 invite-only unchanged (no signup change) ✓. C5 upgrade self-serve in app ✓ B3.1. §4.1 schema ✓ B0.2. §4.2 plans/account-plan ✓ B0.3/B0.4. §4.3 enforcement points (search, chunks, on-demand, workspaces, frescor, feature gates) ✓ B1.1–B1.6. §4.4 Stripe ✓ B2. §4.5 UI app+admin ✓ B3. §5 isolation untouched + owner exempt + secrets in env ✓. §8 DoD (suite incl. isolation, idempotency, invalid signature, e2e) ✓ B1.7/B3.3/B4.9.

**Placeholder scan:** none — every code/test step has full code; commands have expected output.

**Type consistency:** `PlanId`, `PlanLimits`, `PlanFeatures`, `QuotaExceededError(metric,limit,used)`, `WorkspaceLimitError(limit,current)`, `getAccountPlan`, `getBillingRow`, `applySubscriptionState({customerId,plan,status,subscriptionId,currentPeriodEnd})`, `recordBillingEvent/deleteBillingEvent`, `assertSearchWithinLimit/assertChunksWithinLimit/assertOnDemandWithinLimit/assertCanAddWorkspace/accountHasFeature`, `getUsageSnapshot` shape (`{plan, chunks{used,limit}, searches{used,limit}, onDemand{used,limit}}`), `getStripe/__setStripeForTest`, `handleStripeEvent/createStripeWebhookRouter`, `dueAccounts/runResyncTick` — names match across all tasks.

**Known nuance flagged for the executor:** Stripe `current_period_end` may live on subscription items in newer API versions — `periodEndOf()` reads both. Classifier/Revisitar/Briefing remain owner-only (gates ready, per-account feature out of scope).
