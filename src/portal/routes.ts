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
import { isInviteValid, redeemInvite } from "./invites.js";
import { issueMagicLink, consumeMagicLink } from "./magic-link.js";
import { sendMagicLinkEmail } from "./email.js";
import {
  findAccountByEmail,
  createFriendAccount,
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

const BASE_URL = process.env.PORTAL_BASE_URL ?? process.env.BASE_URL ?? "http://localhost:3456";

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
        // New email: require a valid, unused invite. Redeem atomically bound to a
        // pre-generated id; only the single winner then creates that account.
        if (!(await isInviteValid(code))) {
          res.json({ ok: true }); // generic — no account, no email
          return;
        }
        const id = generateFriendAccountId();
        if (!(await redeemInvite(code, id))) {
          res.json({ ok: true }); // lost the race / used meanwhile
          return;
        }
        accountId = await createFriendAccount(email, id);
      }
      await issueAndSend(email, accountId, req);
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
      if (accountId) await issueAndSend(email, accountId, req);
    } catch (err: any) {
      console.error(`[portal] login failed: ${err?.message ?? err}`);
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
    const out: any = { account_id: accountId, email: null, sources: {} };
    try {
      out.email = await getAccountEmail(accountId);
      out.sources = await sourcesSummary(accountId);
    } catch (err: any) {
      console.error(`[portal] /me partial: ${err?.message ?? err}`);
    }
    res.json(out);
  });

  router.get("/portal/sources", requireSession, async (_req, res) => {
    const accountId: string = res.locals.accountId;
    res.json(await sourcesSummary(accountId));
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

  router.get("/portal/notion/connect", requireSession, async (_req, res) => {
    if (!notionClientId) {
      res.status(503).json({ error: "Notion OAuth não configurado" });
      return;
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
  router.post("/portal/reindex", requireSession, async (req, res) => {
    const accountId: string = res.locals.accountId;
    try {
      const { indexAccount } = await import("../rag/index-account.js");
      void indexAccount(accountId).catch((e) =>
        console.error(`[portal] reindex ${accountId} failed: ${e?.message ?? e}`),
      );
      res.status(202).json({ started: true });
    } catch (err: any) {
      console.error(`[portal] reindex unavailable: ${err?.message ?? err}`);
      res.status(503).json({ error: "indexação indisponível neste ambiente" });
    }
  });

  return router;
}

/** Issue a magic link for (email, account) and send it. The verify link points at
 *  the API origin so the cookie is set on the API host. */
async function issueAndSend(email: string, accountId: string, req: express.Request): Promise<void> {
  const token = await issueMagicLink(email, accountId);
  const link = `${BASE_URL}/portal/verify?token=${token}`;
  await sendMagicLinkEmail(email, link);
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
