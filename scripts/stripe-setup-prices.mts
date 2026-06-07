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
