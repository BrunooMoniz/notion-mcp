// src/portal/routes.ts
// 001-account-portal — the friend-facing portal API, mounted at /portal on the
// existing Express server. Two tiers: public (register/login/verify) and
// session-required (everything else). Account scope ALWAYS comes from the
// resolved session, never from request input (FR-011). Heavy rag/notion imports
// are loaded lazily inside handlers so this router can also run in the light
// dev server without booting clients.ts.
import express from "express";
import rateLimit from "express-rate-limit";
import type { Workspace } from "../clients.js"; // type-only: erased at runtime
import { randomUUID, randomBytes } from "node:crypto";
import {
  createSession,
  resolveSession,
  destroySession,
  hashSession,
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
  getAccountCreatedAt,
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
import { listNotionWorkspaces, disconnectNotionWorkspace } from "./notion-workspaces.js";
import { authUrl } from "../google/oauth.js";
import { putPortalGoogleState } from "./google-link.js";
import { listGoogleAccountsMasked, removeGoogleAccount } from "../google/google-accounts.js";
import { assertCanAddWorkspace, WorkspaceLimitError, getUsageSnapshot, assertCreditsWithinLimit, QuotaExceededError } from "../billing/usage.js";
import { PAID_PLANS, priceIdForPlan, getPlanLimits, type PlanId } from "../billing/plans.js";
import { getBillingRow, setStripeCustomerId } from "../billing/account-plan.js";
import { getStripe } from "../billing/stripe.js";
import { deleteAccountCompletely } from "./account-deletion.js";

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
    // 002-app-v2: keep the sign-in browser's User-Agent so "Sessões ativas" is
    // recognizable (truncated inside createSession).
    const sid = await createSession(accountId, new Date(), SESSION_TTL_MS, req.get("user-agent"));
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
    const out: any = { account_id: accountId, email: null, created_at: null, sources: {}, mcp: { url: `${MCP_BASE}/mcp`, configured: false } };
    try {
      out.email = await getAccountEmail(accountId);
      out.created_at = await getAccountCreatedAt(accountId); // 002-app-v2: "membro desde"
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
  // Optional body {label}: which client this token is for (Claude Code / ChatGPT /
  // Outra...) — it becomes the token label shown in "O que sua IA buscou".
  router.post("/portal/mcp-token", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const rawLabel = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const label = rawLabel ? rawLabel.slice(0, 40) : "portal";
    await revokeBearersForAccount(accountId);
    const token = await issueBearer(accountId, label);
    res.json({ token, mcp_url: `${MCP_BASE}/mcp` });
  });

  // Self-service: open a SHORT OAuth Dynamic-Client-Registration window so the
  // friend can add the Zinom connector on claude.ai (which registers itself via
  // /oauth/register) without an operator running a curl. Gated by the portal
  // session — only a signed-in, invite-verified account reaches here — and kept
  // brief: claude.ai's registration is a single call, so a few minutes covers a
  // retry. Registration alone grants nothing (the real gate is /oauth/authorize:
  // email + 6-digit code), so a brief window for an authenticated friend is the
  // right trade, and far better than the manual 60-min operator window.
  const CONNECT_WINDOW_MS = parseInt(process.env.PORTAL_CONNECT_WINDOW_MINUTES ?? "5", 10) * 60_000;
  router.post("/portal/connect-window", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    const { openRegistrationWindow } = await import("../oauth-registration-window.js");
    const expiry = openRegistrationWindow(CONNECT_WINDOW_MS, accountId);
    res.json({
      open_until: new Date(expiry).toISOString(),
      ttl_seconds: Math.round(CONNECT_WINDOW_MS / 1000),
      mcp_url: `${MCP_BASE}/mcp`,
    });
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
            // F7: credit limits
            monthly_credits: l.monthly_credits,
            actions_per_month: l.actions_per_month,
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

  // DELETE account + all data (LGPD). Requires exact confirmation phrase.
  router.post("/portal/delete-account", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    if (req.body?.confirm !== "EXCLUIR") {
      res.status(400).json({ error: "confirmação inválida", hint: 'Envie {confirm:"EXCLUIR"}' });
      return;
    }
    try {
      const sid = readCookie(req, SESSION_COOKIE);
      // Destroy session first so even if deletion is partial the user is logged out.
      await destroySession(sid);
      clearSessionCookie(res);
      const counts = await deleteAccountCompletely(accountId);
      console.log(`[portal] delete-account: ${accountId} deleted counts=${JSON.stringify(counts)}`);
      res.json({ deleted: true, counts });
    } catch (err: any) {
      console.error(`[portal] delete-account failed: ${err?.message ?? err}`);
      res.status(500).json({ error: "falha ao excluir conta" });
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

  // Google Calendar (multi-conta OAuth) --------------------------------------
  router.get("/portal/google/connect", requireSession, (_req, res) => {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      res.redirect(302, "/app.html#fontes?google=unconfigured");
      return;
    }
    const state = randomBytes(16).toString("base64url");
    putPortalGoogleState(state, res.locals.accountId);
    res.redirect(302, authUrl(state));
  });

  router.get("/portal/google/accounts", requireSession, async (_req, res) => {
    res.json(await listGoogleAccountsMasked(res.locals.accountId));
  });

  router.post("/portal/google/disconnect", requireSession, async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    if (!email) {
      res.status(400).json({ error: "email obrigatório" });
      return;
    }
    const ok = await removeGoogleAccount(res.locals.accountId, email);
    res.sendStatus(ok ? 204 : 404);
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

  // List the Notion workspaces connected to THIS session account (id + human
  // name + connected date), so the portal can render a repeatable list with a
  // Remove button per workspace. Account always from the session, never input.
  router.get("/portal/notion/workspaces", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      res.json(await listNotionWorkspaces(accountId));
    } catch (err: any) {
      console.warn(`[portal] notion/workspaces unavailable: ${err?.message ?? err}`);
      res.json([]);
    }
  });

  // Disconnect ONE Notion workspace: delete its vault secrets, drop the
  // account_workspaces row, and purge that workspace's indexed chunks. The
  // workspace id comes from the body but is validated against the SESSION account
  // (disconnectNotionWorkspace returns false if it isn't owned) — isolation.
  router.post("/portal/notion/disconnect", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const workspace = typeof req.body?.workspace === "string" ? req.body.workspace.trim() : "";
    if (!workspace) {
      res.status(400).json({ error: "workspace obrigatório" });
      return;
    }
    try {
      const ok = await disconnectNotionWorkspace(accountId, workspace);
      res.sendStatus(ok ? 204 : 404);
    } catch (err: any) {
      console.error(`[portal] notion/disconnect ${accountId}: ${err?.message ?? err}`);
      res.status(502).json({ error: "não consegui desconectar agora" });
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
    const redirectUri = `${notionBase}/notion/callback`;
    // 1.5: log redirect_uri for diagnostics (no secret exposed — URI is public)
    console.log(`[notion-authorize] portal redirect_uri="${redirectUri}"`);
    res.redirect(
      buildAuthorizeUrl({
        clientId: notionClientId,
        redirectUri,
        state,
      }),
    );
  });

  // Trigger a per-account index over all three sources (US3) ------------------
  // Dedup by account so a friend can't spam concurrent full re-embeds (each runs
  // paid Voyage embeddings) — same in-flight guard the onboarding path uses.
  // Map accountId -> when the in-flight reindex started (feeds the honest
  // per-source "indexando"/"ok" split in /portal/status).
  const reindexInFlight = new Map<string, Date>();
  router.post("/portal/reindex", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    if (reindexInFlight.has(accountId)) {
      res.status(202).json({ started: true, alreadyRunning: true });
      return;
    }
    try {
      const { indexAccount } = await import("../rag/index-account.js");
      reindexInFlight.set(accountId, new Date());
      void indexAccount(accountId)
        .then(async (totals) => {
          // Primeira indexação concluída → avisa por e-mail (uma vez por conta).
          const { notifyFirstIndexDone } = await import("./first-index-notify.js");
          await notifyFirstIndexDone(accountId, totals);
        })
        .catch((e) => console.error(`[portal] reindex ${accountId} failed: ${e?.message ?? e}`))
        .finally(() => reindexInFlight.delete(accountId));
      res.status(202).json({ started: true });
    } catch (err: any) {
      reindexInFlight.delete(accountId);
      console.error(`[portal] reindex unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "indexação indisponível neste ambiente" });
    }
  });

  // --- WS3: status do cérebro + navegação -----------------------------------
  // GET /portal/status — rich, account-scoped indexing status: whether a reindex
  // is running now (in-memory guard), per-source last-run/ok/stale (getStatus +
  // summarizeStatus), and live document/chunk counts (getBrainCounts). Account
  // ALWAYS from the session, never input.
  router.get("/portal/status", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    const running = reindexInFlight.has(accountId);
    let activitySources: unknown[] = [];
    let counts: unknown = { bySource: [], totals: { documents: 0, chunks: 0 } };
    let planLimit = false;
    try {
      const { getStatus, getBrainCounts, getActivitySourceCounts } = await import("../rag/storage.js");
      const { summarizeStatus } = await import("../rag/status.js");
      const { buildActivitySources } = await import("./activity-status.js");
      const { listNotionWorkspaces: lnw } = await import("./notion-workspaces.js");
      const { listIcalMasked: lim } = await import("./sources.js");
      const { getGranolaMasked: ggm } = await import("./sources.js");
      const { listGoogleAccountsMasked: lgam } = await import("../google/google-accounts.js");

      const [rawRuns, brainCounts, liveCountRows, notionWs, icalLinks, granolaState, googleAccounts] =
        await Promise.all([
          getStatus(accountId),
          getBrainCounts(accountId),
          getActivitySourceCounts(accountId).catch(() => []),
          lnw(accountId).catch(
            () => [] as { workspace: string; name: string | null; connection_type: string | null }[],
          ),
          lim(accountId).catch(() => [] as { id: string; label: string }[]),
          ggm(accountId).catch(() => ({ set: false, masked: null })),
          lgam(accountId).catch(() => [] as { email: string }[]),
        ]);

      const summarized = summarizeStatus(rawRuns);
      const liveCounts = new Map(
        liveCountRows.map((r) => [r.source_key, { documents: r.documents, chunks: r.chunks }]),
      );
      activitySources = buildActivitySources(
        {
          notionWorkspaces: notionWs.map((w) => ({
            workspace: w.workspace,
            name: w.name,
            // sem credencial Notion no vault (workspace sintético do Granola/iCal)
            // → não é fonte Notion (bug #96)
            hasCredential: w.connection_type !== null,
          })),
          hasGranola: granolaState.set,
          icalLinks: icalLinks.map((l) => ({ id: l.id, label: l.label })),
          googleAccounts: googleAccounts.map((g) => ({ email: g.email })),
        },
        summarized,
        running,
        { liveCounts, runningSince: reindexInFlight.get(accountId) ?? null },
      );
      counts = brainCounts;
      // bug #96 (3): alguma fonte bateu no teto de chunks do plano → o front
      // mostra o aviso de upgrade.
      planLimit = (activitySources as Array<{ plan_limit?: boolean }>).some(
        (s) => s.plan_limit === true,
      );
    } catch (err: any) {
      // light dev server / no pgvector — still report the running flag.
      console.warn(`[portal] status unavailable: ${err?.message ?? err}`);
    }
    res.json({ running, plan_limit: planLimit, sources: activitySources, counts });
  });

  // GET /portal/brain/documents — browse the account's indexed documents (one row
  // per source_id), optional ?source_type= and ?q= (cheap ILIKE substring),
  // paginated (?limit=&offset=). Pure SQL, no Voyage, no search-quota usage.
  // Multi-entity filter: ?entity_ids=1,2,3&match=all|any (default all).
  // Legacy single: ?entity_id=N (still supported).
  router.get("/portal/brain/documents", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { listBrainDocuments } = await import("../rag/storage.js");
      const entityId = typeof req.query.entity_id === "string" ? parseInt(req.query.entity_id, 10) || undefined : undefined;
      // Multi-entity: ?entity_ids=1,2,3
      const entityIds = typeof req.query.entity_ids === "string"
        ? req.query.entity_ids.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
        : undefined;
      const match = typeof req.query.match === "string" && req.query.match === "any" ? "any" as const : "all" as const;
      const documents = await listBrainDocuments(accountId, {
        q: typeof req.query.q === "string" ? req.query.q : undefined,
        sourceType: typeof req.query.source_type === "string" ? req.query.source_type : undefined,
        limit: typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || undefined : undefined,
        offset: typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) || undefined : undefined,
        entityId,
        entityIds: entityIds && entityIds.length > 0 ? entityIds : undefined,
        match,
      });
      res.json({ documents });
    } catch (err: any) {
      console.warn(`[portal] brain/documents unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "navegação indisponível neste ambiente", documents: [] });
    }
  });

  // GET /portal/brain/entities — list entities for the account, gated by ENTITIES_ENABLED.
  // Returns { entities: [], total: 0 } (200) when flag off, so UI doesn't break.
  router.get("/portal/brain/entities", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    if (process.env.ENTITIES_ENABLED !== "true") {
      res.json({ entities: [], total: 0 });
      return;
    }
    try {
      const { listEntities } = await import("../rag/entity-storage.js");
      const type = typeof req.query.type === "string" ? req.query.type : undefined;
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || undefined : undefined;
      const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) || undefined : undefined;
      const result = await listEntities(accountId, { type, q, limit, offset });
      res.json(result);
    } catch (err: any) {
      console.warn(`[portal] brain/entities unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "entidades indisponíveis", entities: [], total: 0 });
    }
  });

  // GET /portal/brain/entities/:id/documents — documents mentioning a specific entity.
  // 404 if entity does not belong to the account (cross-account guard).
  router.get("/portal/brain/entities/:id/documents", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    if (process.env.ENTITIES_ENABLED !== "true") {
      res.status(404).json({ error: "entidade não encontrada" });
      return;
    }
    const entityId = parseInt(req.params.id, 10);
    if (isNaN(entityId)) {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    try {
      const { listEntityDocuments } = await import("../rag/entity-storage.js");
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || undefined : undefined;
      const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) || undefined : undefined;
      const result = await listEntityDocuments(accountId, entityId, { limit, offset });
      if (result === null) {
        res.status(404).json({ error: "entidade não encontrada" });
        return;
      }
      res.json(result);
    } catch (err: any) {
      console.warn(`[portal] brain/entities/:id/documents unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "entidades indisponíveis" });
    }
  });

  // POST /portal/brain/entities/merge — merge two entities (irreversible).
  // Body: { keep_id: number, merge_id: number }
  // 404 if either entity is not in this account (cross-account guard).
  router.post("/portal/brain/entities/merge", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    if (process.env.ENTITIES_ENABLED !== "true") {
      res.status(404).json({ error: "entidade não encontrada" });
      return;
    }
    const keepId = parseInt(req.body?.keep_id, 10);
    const mergeId = parseInt(req.body?.merge_id, 10);
    if (isNaN(keepId) || isNaN(mergeId)) {
      res.status(400).json({ error: "keep_id e merge_id são obrigatórios" });
      return;
    }
    if (keepId === mergeId) {
      res.status(400).json({ error: "keep_id e merge_id devem ser diferentes" });
      return;
    }
    try {
      const { mergeEntities } = await import("../rag/entity-management.js");
      const result = await mergeEntities(accountId, keepId, mergeId);
      if ("error" in result) {
        res.status(404).json({ error: "entidade não encontrada" });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.warn(`[portal] brain/entities/merge failed: ${err?.message ?? err}`);
      res.status(503).json({ error: "operação indisponível" });
    }
  });

  // PATCH /portal/brain/entities/:id — rename and/or retype entity.
  // Body: { name?: string, type?: string }
  // 404 if entity is not in this account (cross-account guard).
  router.patch("/portal/brain/entities/:id", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    if (process.env.ENTITIES_ENABLED !== "true") {
      res.status(404).json({ error: "entidade não encontrada" });
      return;
    }
    const entityId = parseInt(req.params.id, 10);
    if (isNaN(entityId)) {
      res.status(400).json({ error: "id inválido" });
      return;
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const type = typeof req.body?.type === "string" ? req.body.type.trim() : undefined;
    if (!name && !type) {
      res.status(400).json({ error: "name ou type é obrigatório" });
      return;
    }
    const VALID_TYPES = ["pessoa", "empresa", "projeto"];
    if (type && !VALID_TYPES.includes(type)) {
      res.status(400).json({ error: "type inválido; válidos: pessoa, empresa, projeto" });
      return;
    }
    try {
      const { renameEntity } = await import("../rag/entity-management.js");
      const result = await renameEntity(accountId, entityId, { name, type });
      if ("error" in result) {
        res.status(404).json({ error: "entidade não encontrada" });
        return;
      }
      res.json(result);
    } catch (err: any) {
      console.warn(`[portal] brain/entities/:id PATCH failed: ${err?.message ?? err}`);
      res.status(503).json({ error: "operação indisponível" });
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
      const { invalidateTrackerProfile } = await import("../tasks/adapter.js");
      const { dataSourceId } = await createTaskTracker(accountId);
      // tasks_db mudou → o profile cacheado (5 min) não pode sobreviver.
      invalidateTrackerProfile(accountId);
      res.status(201).json({ data_source_id: dataSourceId });
    } catch (err: any) {
      console.error(`[portal] tasks/create ${accountId}: ${err?.message ?? err}`);
      res.status(400).json({ error: err?.message ?? "não consegui criar as Tarefas" });
    }
  });

  // Usa uma DB existente que a pessoa escolheu: VALIDA a leitura ANTES de
  // persistir (lê o schema da base candidata via o seam do adapter, sem tocar o
  // vault). Base legível grava MESMO com campos missing — o adapter se adapta ao
  // schema; base ilegível → 400 sem gravar nada.
  router.post("/portal/tasks/use", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const id = typeof req.body?.data_source_id === "string" ? req.body.data_source_id.trim() : "";
    if (!id) {
      res.status(400).json({ error: "data_source_id obrigatório" });
      return;
    }
    try {
      const { getTasksInfo, invalidateTrackerProfile } = await import("../tasks/adapter.js");
      invalidateTrackerProfile(accountId);
      let info: Awaited<ReturnType<typeof getTasksInfo>>;
      try {
        info = await getTasksInfo(accountId, { getTasksDbIdImpl: async () => id });
        if (!info.configured) throw new Error("base não legível");
      } catch (err: any) {
        invalidateTrackerProfile(accountId);
        console.warn(`[portal] tasks/use validate ${accountId}: ${err?.message ?? err}`);
        res.status(400).json({
          error: "unreadable",
          message: "não consegui ler essa base agora — confira o acesso e tente de novo",
        });
        return;
      }
      const { useExistingTracker } = await import("./task-tracker.js");
      await useExistingTracker(accountId, id);
      invalidateTrackerProfile(accountId);
      res.json({ ...info, configured: true });
    } catch (err: any) {
      console.error(`[portal] tasks/use ${accountId}: ${err?.message ?? err}`);
      res.status(400).json({ error: err?.message ?? "não consegui usar essa base" });
    }
  });

  // 003-tasks-v1: estado da base de tarefas — o que o adapter mapeou/faltou.
  router.get("/portal/tasks/info", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { getTasksInfo } = await import("../tasks/adapter.js");
      res.json(await getTasksInfo(accountId));
    } catch (err: any) {
      console.error(`[portal] tasks/info ${accountId}: ${err?.message ?? err}`);
      res.status(502).json({ error: "não consegui ler sua base de tarefas agora" });
    }
  });

  // 003-tasks-v1: upgrade ADITIVO do template padrão "Tarefas" (nunca muta base
  // arbitrária do usuário — o módulo recusa título diferente de "Tarefas").
  router.post("/portal/tasks/upgrade", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { upgradeStandardTracker } = await import("../tasks/upgrade.js");
      const r = await upgradeStandardTracker(accountId);
      res.json({ ok: true, added: r.added });
    } catch (err: any) {
      console.error(`[portal] tasks/upgrade ${accountId}: ${err?.message ?? err}`);
      res.status(400).json({ ok: false, error: err?.message ?? "não consegui atualizar o template" });
    }
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

  // --- P1: chat com o cérebro --------------------------------------------------
  // Per-account rate limiter factory (keyed by accountId — behind the Tailscale
  // funnel all IPs are loopback, so an IP key would bucket all callers into one
  // window). Each caller gets its OWN limiter instance = its own window.
  const makeRateLimiter = (opts: { windowMs?: number; max?: number } = {}) =>
    rateLimit({
      windowMs: opts.windowMs ?? 60_000,
      max: opts.max ?? 10,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req, res) => (res as any).locals?.accountId ?? req.ip ?? "anon",
      validate: { keyGeneratorIpFallback: false },
      message: { error: "Too many requests, try again later" },
      skip: () => false,
    });

  // 10 requisições/min por conta.
  const askLimiter = makeRateLimiter();

  router.post("/portal/ask", requireSession, askLimiter, async (req, res) => {
    const { handleAsk } = await import("./ask.js");
    await handleAsk(req, res);
  });

  // POST /portal/feedback {chunk_id, value: "up"|"down", query?}
  // Spec 004 §4: explicit user 👍/👎 on a cited source in the chat UI.
  // Scope: account_id always from session (never from request).
  // Idempotency: simple — server accepts and applies the delta; client controls
  // "1 vote per chunk per chat session" (tracked in chat JS state).
  router.post("/portal/feedback", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const chunkId = typeof req.body?.chunk_id === "string" ? req.body.chunk_id.trim() : "";
    const value = req.body?.value;
    const query = typeof req.body?.query === "string" ? req.body.query.slice(0, 300) : undefined;

    if (!chunkId || !["up", "down"].includes(value)) {
      res.status(400).json({ error: "chunk_id e value (up|down) são obrigatórios" });
      return;
    }

    try {
      const { applyFeedback } = await import("../rag/feedback.js");
      const { UTILITY_WEIGHTS } = await import("../rag/utility.js");
      const delta = value === "up" ? UTILITY_WEIGHTS.user_thumb_up : UTILITY_WEIGHTS.user_thumb_down;
      const result = await applyFeedback({ accountId, chunkId, source: "user_thumb", delta, query });
      if (result.status === "not_found") {
        res.status(404).json({ error: "chunk_not_found" });
        return;
      }
      res.json({ ok: true, new_score: result.newScore });
    } catch (err: any) {
      console.error(`[portal] feedback ${accountId}: ${err?.message ?? err}`);
      res.status(500).json({ error: "server_error" });
    }
  });

  // POST /portal/ask/execute — execute a proposed action after user confirmation.
  // Same rate limit as /portal/ask (shared window). Audited in executeAction.
  router.post("/portal/ask/execute", requireSession, askLimiter, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const proposed = req.body?.proposed_action;
    if (
      !proposed ||
      typeof proposed !== "object" ||
      !["criar_evento", "criar_tarefa", "criar_pagina_notion"].includes(proposed.type) ||
      typeof proposed.resumo !== "string"
    ) {
      res.status(400).json({ error: "proposed_action inválido ou ausente" });
      return;
    }
    try {
      // F7: credit gate for action execution (2 credits). Respects PLAN_ENFORCEMENT.
      await assertCreditsWithinLimit(accountId, "action", 2);

      const { executeAction } = await import("./ask-actions.js");
      const result = await executeAction(accountId, {
        type: proposed.type,
        params: typeof proposed.params === "object" && proposed.params !== null ? proposed.params : {},
        resumo: proposed.resumo,
      });
      if (result.ok) {
        // F7: meter action credit usage (best-effort).
        const { recordUsage: recordUsageAction } = await import("../rag/usage.js");
        recordUsageAction(accountId, "action", 1).catch(() => {/* swallowed */});

        // Spec 004 §4: implicit_action — chunks cited in the proposal get +1.0
        // when the user confirms the action. The client may send cited_chunk_ids.
        // Best-effort: never blocks the response.
        const citedChunkIds: string[] = Array.isArray(req.body?.cited_chunk_ids)
          ? (req.body.cited_chunk_ids as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        if (citedChunkIds.length > 0) {
          (async () => {
            try {
              const { applyFeedback } = await import("../rag/feedback.js");
              const { UTILITY_WEIGHTS } = await import("../rag/utility.js");
              for (const chunkId of citedChunkIds) {
                await applyFeedback({
                  accountId,
                  chunkId,
                  source: "implicit_action",
                  delta: UTILITY_WEIGHTS.implicit_action,
                  query: proposed.resumo,
                });
              }
            } catch { /* swallowed */ }
          })();
        }
        res.json({ ok: true, message: result.message, url: result.url ?? null });
      } else {
        res.status(422).json({ ok: false, error: result.error, message: result.message });
      }
    } catch (err: any) {
      if (err instanceof QuotaExceededError) {
        res.status(402).json({ ok: false, error: "quota", message: err.message });
        return;
      }
      console.error(`[portal] ask/execute ${accountId}: ${err?.message ?? err}`);
      res.status(500).json({ ok: false, error: "server_error", message: "Erro interno ao executar a ação." });
    }
  });

  // --- MCP token list + per-token revoke ---------------------------------------
  // GET /portal/mcp-tokens — list tokens for the session account.
  // Returns [{id: token_hash, name, created_at, last_used_at}]. The hash is
  // safe to expose (SHA-256, not the plaintext token). Account always from session.
  router.get("/portal/mcp-tokens", requireSession, async (_req, res) => {
    const { listMcpTokens } = await import("./mcp-tokens.js");
    res.json(await listMcpTokens(res.locals.accountId));
  });

  // POST /portal/mcp-tokens/revoke {id: token_hash} — delete ONE token.
  // 204 on success; 404 if not found or belongs to another account (no-op).
  router.post("/portal/mcp-tokens/revoke", requireSession, async (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!id) {
      res.status(400).json({ error: "id obrigatório" });
      return;
    }
    const { revokeMcpToken } = await import("./mcp-tokens.js");
    const ok = await revokeMcpToken(res.locals.accountId, id);
    res.sendStatus(ok ? 204 : 404);
  });

  // --- 002-app-v2: app v2 cards + session management -------------------------
  // All behind requireSession; account_id ALWAYS from the session, never input.

  // GET /portal/ai-searches — "O que sua IA buscou": last 7 days, max 50, desc.
  router.get("/portal/ai-searches", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { listSearchEvents } = await import("../rag/search-log.js");
      res.json({ searches: await listSearchEvents(accountId, { days: 7, limit: 50 }) });
    } catch (err: any) {
      console.warn(`[portal] ai-searches unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "histórico indisponível", searches: [] });
    }
  });

  // GET /portal/week — "Sua semana": 7-day window over the account's brain.
  router.get("/portal/week", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { getWeekSummary } = await import("./week.js");
      res.json(await getWeekSummary(accountId));
    } catch (err: any) {
      console.warn(`[portal] week unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "resumo indisponível", documents: 0, meetings: 0, by_source: [], recent: [] });
    }
  });

  // GET /portal/next-meeting — next FUTURE calendar event from indexed chunks.
  router.get("/portal/next-meeting", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { getNextMeeting } = await import("./next-meeting.js");
      res.json(await getNextMeeting(accountId));
    } catch (err: any) {
      console.warn(`[portal] next-meeting unavailable: ${err?.message ?? err}`);
      res.json({ found: false });
    }
  });

  // POST /portal/index-web {url} — index a pasted URL into the account's brain.
  // Same core path (URL fetch + SSRF guard + index_pages quota) as the
  // brain_index_web MCP tool, with the SESSION account passed explicitly.
  // Rate-limited per account like /portal/ask (own window — indexing pages must
  // not consume the chat budget).
  const indexWebLimiter = makeRateLimiter();
  router.post("/portal/index-web", requireSession, indexWebLimiter, async (req, res) => {
    const accountId: string = res.locals.accountId;
    const { parseHttpUrl } = await import("./index-web.js");
    const url = parseHttpUrl(req.body?.url);
    if (!url) {
      res.status(400).json({ error: "invalid_url", message: "Cole uma URL http(s) válida." });
      return;
    }
    try {
      const { indexWebForAccount } = await import("../rag/brain-index-web-tool.js");
      // Tag the page with the account's first workspace (same default the MCP
      // tool applies for a friend token) so their scoped bearer can read it.
      const { accountWorkspaces } = await import("../account-bearer.js");
      const ws = await accountWorkspaces(accountId).catch(() => [] as string[]);
      const workspaceTag = (ws[0] ?? "personal") as Workspace;
      const out = await indexWebForAccount(accountId, url, workspaceTag);
      res.json({ ok: true, title: out.title ?? undefined });
    } catch (err: any) {
      if (err instanceof QuotaExceededError) {
        res.status(402).json({ error: "quota", message: err.message });
        return;
      }
      console.warn(`[portal] index-web ${accountId}: ${err?.message ?? err}`);
      res.status(422).json({ error: "index_failed", message: "Não consegui indexar essa página agora." });
    }
  });

  // GET /portal/sessions — active sessions for the account (id = session_hash).
  router.get("/portal/sessions", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const sid = readCookie(req, SESSION_COOKIE);
      const { listSessions } = await import("./sessions.js");
      res.json({ sessions: await listSessions(accountId, sid ? hashSession(sid) : "") });
    } catch (err: any) {
      console.warn(`[portal] sessions unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "sessões indisponíveis", sessions: [] });
    }
  });

  // POST /portal/sessions/revoke {id} — 204; 404 if not this account's session.
  // Revoking the CURRENT session is allowed (front redirects to login).
  router.post("/portal/sessions/revoke", requireSession, async (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!id) {
      res.status(400).json({ error: "id obrigatório" });
      return;
    }
    try {
      const { revokeSession } = await import("./sessions.js");
      const ok = await revokeSession(res.locals.accountId, id);
      res.sendStatus(ok ? 204 : 404);
    } catch (err: any) {
      console.error(`[portal] sessions/revoke failed: ${err?.message ?? err}`);
      res.status(500).json({ error: "server_error" });
    }
  });

  // GET /portal/brain/graph — entity+document co-occurrence graph for the account.
  // Gated by ENTITIES_ENABLED (same as /portal/brain/entities).
  // Params:
  //   ?mode=overview|focus  (default: overview)
  //   ?type=                entity type filter
  //   ?entity_ids=1,2,3     focus mode: comma-separated entity IDs
  //   ?entity_id=N          legacy single entity_id (still supported)
  //   ?include_docs=true    include doc nodes in focus mode (default false)
  //   ?max_nodes=N          cap (overview default 40, focus default 60, max 150)
  router.get("/portal/brain/graph", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    if (process.env.ENTITIES_ENABLED !== "true") {
      res.json({ nodes: [], edges: [], mode: "overview" });
      return;
    }
    try {
      const { buildBrainGraph } = await import("../rag/graph-storage.js");
      const type = typeof req.query.type === "string" ? req.query.type : undefined;
      const modeRaw = typeof req.query.mode === "string" ? req.query.mode : undefined;
      const mode: "overview" | "focus" | undefined =
        modeRaw === "focus" ? "focus" : modeRaw === "overview" ? "overview" : undefined;

      // entity_ids: comma-separated list e.g. ?entity_ids=1,2,3
      const entity_ids =
        typeof req.query.entity_ids === "string"
          ? req.query.entity_ids.split(",").map(Number).filter(Boolean)
          : undefined;

      // legacy single entity_id
      const entity_id =
        typeof req.query.entity_id === "string"
          ? parseInt(req.query.entity_id, 10) || undefined
          : undefined;

      const include_docs = req.query.include_docs === "true";

      const max_nodes =
        typeof req.query.max_nodes === "string"
          ? parseInt(req.query.max_nodes, 10) || undefined
          : undefined;

      const graph = await buildBrainGraph(accountId, {
        mode,
        type,
        entity_ids,
        entity_id,
        include_docs,
        max_nodes,
      });
      res.json(graph);
    } catch (err: any) {
      console.warn(`[portal] brain/graph unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "grafo indisponível", nodes: [], edges: [], mode: "overview" });
    }
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
  // The repeatable Notion list (id + human name + connected date). The legacy
  // `connected` boolean stays for backward compat; the front prefers `workspaces`.
  const notionWorkspaces = await listNotionWorkspaces(accountId).catch(() => []);
  const notionConnected =
    notionWorkspaces.length > 0 ||
    (await hasNotionWorkspace(accountId).catch(() => false)) ||
    Boolean(runs.notion);
  const ical = await listIcalMasked(accountId);
  const granola = await getGranolaMasked(accountId);
  return {
    notion: {
      connected: notionConnected,
      workspaces: notionWorkspaces,
      count: notionWorkspaces.length,
      ...(runs.notion ?? {}),
    },
    granola: { ...granola, ...(runs.granola ?? {}) },
    ical: { links: ical, count: ical.length, ...(runs.ical ?? {}) },
  };
}
