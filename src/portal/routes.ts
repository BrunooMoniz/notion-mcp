// src/portal/routes.ts
// 001-account-portal — the friend-facing portal API, mounted at /portal on the
// existing Express server. Two tiers: public (register/login/verify) and
// session-required (everything else). Account scope ALWAYS comes from the
// resolved session, never from request input (FR-011). Heavy rag/notion imports
// are loaded lazily inside handlers so this router can also run in the light
// dev server without booting clients.ts.
import express from "express";
import { randomUUID } from "node:crypto";
import {
  createSession,
  resolveSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./session.js";
import { isInviteValid } from "./invites.js";
import { issueMagicLink, consumeMagicLink } from "./magic-link.js";
import { issueBearer, revokeBearersForAccount, accountHasBearer } from "../account-bearer.js";
import { sendMagicLinkEmail } from "./email.js";
import {
  findAccountByEmail,
  redeemInviteAndCreateAccount,
  generateFriendAccountId,
  getAccountEmail,
  hasNotionWorkspace,
  normalizeEmail,
  isLikelyEmail,
} from "./accounts.js";
import {
  addIcalLink,
  updateIcalLink,
  removeIcalLink,
  listIcalMasked,
  setGranolaKey,
  removeGranolaKey,
  getGranolaMasked,
} from "./sources.js";
import { assertCanAddWorkspace, WorkspaceLimitError, getUsageSnapshot } from "../billing/usage.js";
import { PAID_PLANS, priceIdForPlan, getPlanLimits, type PlanId } from "../billing/plans.js";
import { getBillingRow, setStripeCustomerId } from "../billing/account-plan.js";
import { getStripe } from "../billing/stripe.js";

const BASE_URL = process.env.PORTAL_BASE_URL ?? process.env.BASE_URL ?? "http://localhost:3456";
// The canonical server origin where the MCP endpoint (/mcp) lives — what a friend
// puts in their AI client. Always the real server URL, not a Pages front.
const MCP_BASE = process.env.BASE_URL ?? BASE_URL;

/** Parse a single cookie value out of the Cookie header (no cookie-parser dep). */
function readCookie(req: express.Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Secure cookie behind TLS (prod, via the funnel's X-Forwarded-Proto) but not on
 *  plain http://localhost (dev), where a Secure cookie would be dropped. Override
 *  with PORTAL_COOKIE_SECURE=0 (force off) / =1 (force on) if a proxy misreports. */
function cookieSecure(req: express.Request): boolean {
  const override = process.env.PORTAL_COOKIE_SECURE;
  if (override === "0") return false;
  if (override === "1") return true;
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req: express.Request, res: express.Response, value: string): void {
  res.cookie(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    maxAge: SESSION_TTL_MS,
    domain: process.env.PORTAL_SESSION_COOKIE_DOMAIN || undefined,
  });
}

function clearSessionCookie(res: express.Response): void {
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    domain: process.env.PORTAL_SESSION_COOKIE_DOMAIN || undefined,
  });
}

export function createPortalRouter(): express.Router {
  const router = express.Router();

  // --- Public ---------------------------------------------------------------

  // POST /portal/register {invite_code, email}. Invite-gated for NEW emails; an
  // already-known email is treated as a sign-in (invite not consumed). Always a
  // generic 200 so the endpoint never reveals which emails/invites exist.
  router.post("/portal/register", async (req, res) => {
    const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    const code = typeof req.body?.invite_code === "string" ? req.body.invite_code.trim() : "";
    if (!isLikelyEmail(email)) {
      res.status(400).json({ error: "e-mail inválido" });
      return;
    }
    try {
      let accountId = await findAccountByEmail(email);
      if (!accountId) {
        // New email: require a valid, unused invite. Redeem + create the account
        // in ONE transaction so the single-use invite is never burned without its
        // account (e.g. on a unique-email race or a transient DB error → throws →
        // generic 200, invite stays valid for retry).
        if (!(await isInviteValid(code))) {
          res.json({ ok: true }); // generic — no account, no email
          return;
        }
        const id = generateFriendAccountId();
        if ((await redeemInviteAndCreateAccount(code, id, email)) === "lost-race") {
          res.json({ ok: true }); // used / lost the race meanwhile
          return;
        }
        accountId = id;
      }
      await issueAndSend(email, accountId);
    } catch (err: any) {
      console.error(`[portal] register failed: ${err?.message ?? err}`);
    }
    res.json({ ok: true });
  });

  // POST /portal/login {email}. Sign-in for an existing friend (no invite).
  router.post("/portal/login", async (req, res) => {
    const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    if (!isLikelyEmail(email)) {
      res.status(400).json({ error: "e-mail inválido" });
      return;
    }
    try {
      const accountId = await findAccountByEmail(email);
      if (accountId) await issueAndSend(email, accountId);
    } catch (err: any) {
      console.error(`[portal] login failed: ${err?.message ?? err}`);
    }
    res.json({ ok: true });
  });

  // POST /portal/request-invite {email, name?, note?} — a visitor asks for access.
  // `note` carries the landing's "como pretende usar" free-text. Lands in the leads
  // list (/admin, which shows both name and note). Generic 200 (no enumeration).
  router.post("/portal/request-invite", async (req, res) => {
    const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    if (!isLikelyEmail(email)) {
      res.status(400).json({ error: "e-mail inválido" });
      return;
    }
    try {
      const { createInviteRequest } = await import("./leads.js");
      await createInviteRequest(email, name, note);
    } catch (err: any) {
      console.error(`[portal] request-invite failed: ${err?.message ?? err}`);
    }
    res.json({ ok: true });
  });

  // GET /portal/verify?token=... — consume the magic link, open a session.
  router.get("/portal/verify", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const result = await consumeMagicLink(token);
    if (!result) {
      res.redirect("/?error=link");
      return;
    }
    const accountId = result.accountId ?? (await findAccountByEmail(result.email));
    if (!accountId) {
      res.redirect("/?error=link");
      return;
    }
    const sid = await createSession(accountId);
    setSessionCookie(req, res, sid);
    res.redirect("/app.html");
  });

  // --- Session-required -----------------------------------------------------

  const requireSession: express.RequestHandler = async (req, res, next) => {
    const sid = readCookie(req, SESSION_COOKIE);
    const accountId = await resolveSession(sid);
    if (!accountId) {
      res.status(401).json({ error: "not signed in" });
      return;
    }
    res.locals.accountId = accountId;
    next();
  };

  router.post("/portal/logout", requireSession, async (req, res) => {
    await destroySession(readCookie(req, SESSION_COOKIE));
    clearSessionCookie(res);
    res.sendStatus(204);
  });

  router.get("/portal/me", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    const out: any = { account_id: accountId, email: null, sources: {}, mcp: { url: `${MCP_BASE}/mcp`, configured: false } };
    try {
      out.email = await getAccountEmail(accountId);
      out.sources = await sourcesSummary(accountId);
      out.mcp.configured = await accountHasBearer(accountId);
    } catch (err: any) {
      console.error(`[portal] /me partial: ${err?.message ?? err}`);
    }
    res.json(out);
  });

  router.get("/portal/sources", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    res.json(await sourcesSummary(accountId));
  });

  // Generate (or regenerate) the per-account MCP bearer the friend puts in their
  // AI client. Shown ONCE; only its hash is stored. Regenerating revokes the old
  // one so there's a single active token (the friend updates their client).
  router.post("/portal/mcp-token", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    await revokeBearersForAccount(accountId);
    const token = await issueBearer(accountId, "portal");
    res.json({ token, mcp_url: `${MCP_BASE}/mcp` });
  });

  // --- Billing (Fase 3) -----------------------------------------------------
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

  // iCal links (multiple) ----------------------------------------------------
  router.post("/portal/ical", requireSession, async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "url obrigatória" });
      return;
    }
    const id = await addIcalLink(res.locals.accountId, {
      url,
      label: typeof req.body?.label === "string" ? req.body.label : "",
      workspace: typeof req.body?.workspace === "string" ? req.body.workspace : "personal",
    });
    res.status(201).json({ id });
  });

  router.put("/portal/ical/:id", requireSession, async (req, res) => {
    const ok = await updateIcalLink(res.locals.accountId, req.params.id, {
      url: typeof req.body?.url === "string" ? req.body.url.trim() : undefined,
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      workspace: typeof req.body?.workspace === "string" ? req.body.workspace : undefined,
    });
    res.sendStatus(ok ? 200 : 404);
  });

  router.delete("/portal/ical/:id", requireSession, async (req, res) => {
    const ok = await removeIcalLink(res.locals.accountId, req.params.id);
    res.sendStatus(ok ? 204 : 404);
  });

  // Granola (single key) -----------------------------------------------------
  router.put("/portal/granola", requireSession, async (req, res) => {
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!key) {
      res.status(400).json({ error: "key obrigatória" });
      return;
    }
    await setGranolaKey(res.locals.accountId, key);
    res.sendStatus(200);
  });

  router.delete("/portal/granola", requireSession, async (_req, res) => {
    await removeGranolaKey(res.locals.accountId);
    res.sendStatus(204);
  });

  // Notion connect/re-auth. Reuses the EXISTING registered redirect URI
  // (/notion/callback); we stash the portal account against the OAuth state so
  // that callback associates the workspace to THIS account (see notion-link.ts +
  // notion-routes.ts). No new redirect URI to register in the Notion app.
  const notionClientId = process.env.NOTION_OAUTH_CLIENT_ID;
  const notionBase = process.env.BASE_URL ?? "https://vps-1200754.tail30b723.ts.net";

  // Connect Notion with a Personal Access Token: full workspace access + /v1/search
  // works (verified), so it auto-indexes normally — the easiest path. Bound to the
  // session account (see associatePatToAccount).
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
    const { putPortalNotionState } = await import("./notion-link.js");
    const state = randomUUID();
    putPortalNotionState(state, res.locals.accountId);
    res.redirect(
      buildAuthorizeUrl({
        clientId: notionClientId,
        redirectUri: `${notionBase}/notion/callback`,
        state,
      }),
    );
  });

  // Trigger a per-account index over all three sources (US3) ------------------
  // Dedup by account so a friend can't spam concurrent full re-embeds (each runs
  // paid Voyage embeddings) — same in-flight guard the onboarding path uses.
  const reindexInFlight = new Set<string>();
  router.post("/portal/reindex", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    if (reindexInFlight.has(accountId)) {
      res.status(202).json({ started: true, alreadyRunning: true });
      return;
    }
    try {
      const { indexAccount } = await import("../rag/index-account.js");
      reindexInFlight.add(accountId);
      void indexAccount(accountId)
        .catch((e) => console.error(`[portal] reindex ${accountId} failed: ${e?.message ?? e}`))
        .finally(() => reindexInFlight.delete(accountId));
      res.status(202).json({ started: true });
    } catch (err: any) {
      reindexInFlight.delete(accountId);
      console.error(`[portal] reindex unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "indexação indisponível neste ambiente" });
    }
  });

  // --- Ativação (checklist one-time) ----------------------------------------
  router.get("/portal/activation", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    const { getActivationState } = await import("./activation.js");
    res.json(await getActivationState(accountId));
  });

  // Detecta candidatas a Task Tracker no Notion da conta (não escreve nada).
  router.post("/portal/tasks/detect", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { detectTaskTracker } = await import("./task-tracker.js");
      res.json(await detectTaskTracker(accountId));
    } catch (err: any) {
      console.error(`[portal] tasks/detect ${accountId}: ${err?.message ?? err}`);
      res.status(502).json({ error: "não consegui ler seu Notion agora" });
    }
  });

  // Cria a DB "Tarefas" (página-mãe "🧠 Zinom" no topo). Só com confirmação (POST).
  router.post("/portal/tasks/create", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { createTaskTracker } = await import("./task-tracker.js");
      const { dataSourceId } = await createTaskTracker(accountId);
      res.status(201).json({ data_source_id: dataSourceId });
    } catch (err: any) {
      console.error(`[portal] tasks/create ${accountId}: ${err?.message ?? err}`);
      res.status(400).json({ error: err?.message ?? "não consegui criar as Tarefas" });
    }
  });

  // Usa uma DB existente que a pessoa escolheu (grava o id; não muta schema no MVP).
  router.post("/portal/tasks/use", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const id = typeof req.body?.data_source_id === "string" ? req.body.data_source_id.trim() : "";
    if (!id) {
      res.status(400).json({ error: "data_source_id obrigatório" });
      return;
    }
    const { useExistingTracker } = await import("./task-tracker.js");
    await useExistingTracker(accountId, id);
    res.sendStatus(200);
  });

  router.post("/portal/activation/ask", requireSession, async (_req, res) => {
    const { markAsked } = await import("./activation.js");
    await markAsked(res.locals.accountId);
    res.sendStatus(200);
  });

  router.post("/portal/activation/dismiss", requireSession, async (_req, res) => {
    const { dismissActivation } = await import("./activation.js");
    await dismissActivation(res.locals.accountId);
    res.sendStatus(200);
  });

  return router;
}

/** Issue a magic link for (email, account) and send it. The verify link points at
 *  the API origin so the cookie is set on the API host. The send is fire-and-forget
 *  (not awaited) so the public endpoints respond in the same DB-bound time whether
 *  or not the email exists — closing a response-timing enumeration oracle (the
 *  Resend round-trip is hundreds of ms and would otherwise only happen for known
 *  emails). The link token is already persisted, so a send failure just means no
 *  email; a re-request issues a fresh link. */
async function issueAndSend(email: string, accountId: string): Promise<void> {
  const token = await issueMagicLink(email, accountId);
  const link = `${BASE_URL}/portal/verify?token=${token}`;
  void sendMagicLinkEmail(email, link).catch((e) =>
    console.error(`[portal] magic-link send failed: ${e?.message ?? e}`),
  );
}

/** Derived per-source status for /me and /sources: vault presence + last run. */
async function sourcesSummary(accountId: string): Promise<any> {
  const runs: Record<string, { ok: boolean; error: string | null; last_run: Date | null }> = {};
  try {
    const { getStatus } = await import("../rag/storage.js");
    for (const r of await getStatus(accountId)) {
      const key = r.source.startsWith("notion")
        ? "notion"
        : r.source.startsWith("granola")
          ? "granola"
          : r.source.startsWith("calendar")
            ? "ical"
            : r.source;
      runs[key] = { ok: r.ok, error: r.error, last_run: r.last_run_at };
    }
  } catch {
    /* status table may be absent in the light dev DB — ignore */
  }
  const notionConnected = await hasNotionWorkspace(accountId).catch(() => false);
  const ical = await listIcalMasked(accountId);
  const granola = await getGranolaMasked(accountId);
  return {
    notion: { connected: notionConnected || Boolean(runs.notion), ...(runs.notion ?? {}) },
    granola: { ...granola, ...(runs.granola ?? {}) },
    ical: { links: ical, count: ical.length, ...(runs.ical ?? {}) },
  };
}
