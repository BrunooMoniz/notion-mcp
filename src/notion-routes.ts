// src/notion-routes.ts
// F3.2 — Express routes for Notion onboarding:
//   GET /notion/connect  -> issues a CSRF state and redirects to Notion authorize
//   GET /notion/callback -> validates state, exchanges code, onboards the account
// Additive + self-contained: when NOTION_OAUTH_CLIENT_ID/SECRET are unset these
// routes return 503 and nothing else in the server is affected.
import express from "express";
import { randomUUID } from "node:crypto";
import { buildAuthorizeUrl, exchangeCodeForToken, onboardAccount } from "./notion-oauth.js";
import { escapeHtml } from "./rag/status.js";

const STATE_TTL_MS = 10 * 60_000; // 10 min to complete the consent

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:64px auto;padding:0 20px}h1{font-size:22px}.ok{color:#1f8b4c}.bad{color:#d83a3a}</style></head><body>${body}</body></html>`;
}

export function createNotionOnboardRouter(): express.Router {
  const router = express.Router();
  const BASE_URL = process.env.BASE_URL ?? "https://vps-1200754.tail30b723.ts.net";
  const redirectUri = `${BASE_URL}/notion/callback`;
  const clientId = process.env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET;

  // In-memory CSRF nonces (single-instance server). state -> issuedAt.
  const states = new Map<string, number>();
  const sweep = () => {
    const now = Date.now();
    for (const [s, t] of states) if (now - t > STATE_TTL_MS) states.delete(s);
  };

  router.get("/notion/connect", (_req, res) => {
    if (!clientId) {
      res.status(503).type("html").send(page("Indisponível", `<p class="bad">Onboarding do Notion não configurado.</p>`));
      return;
    }
    sweep();
    const state = randomUUID();
    states.set(state, Date.now());
    res.redirect(buildAuthorizeUrl({ clientId, redirectUri, state }));
  });

  router.get("/notion/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      res.status(400).type("html").send(page("Autorização negada", `<h1 class="bad">Autorização negada</h1><p>${escapeHtml(String(error))}</p>`));
      return;
    }
    if (!clientId || !clientSecret) {
      res.status(503).type("html").send(page("Indisponível", `<p class="bad">Onboarding do Notion não configurado.</p>`));
      return;
    }
    if (typeof code !== "string" || !code) {
      res.status(400).type("html").send(page("Erro", `<p class="bad">Faltou o parâmetro <code>code</code>.</p>`));
      return;
    }
    // CSRF: only accept a state we issued (and not yet used).
    sweep();
    if (typeof state !== "string" || !states.has(state)) {
      res.status(400).type("html").send(page("Erro", `<p class="bad">State inválido ou expirado (proteção CSRF). Recomece em <code>/notion/connect</code>.</p>`));
      return;
    }
    states.delete(state);
    try {
      const tok = await exchangeCodeForToken(code, redirectUri, { clientId, clientSecret });
      const { accountId } = await onboardAccount(tok);
      const wsName = tok.workspace_name ?? tok.workspace_id;
      console.log(`[notion-onboard] account=${accountId} workspace="${wsName}" connected`);
      res.type("html").send(
        page(
          "Conectado",
          `<h1 class="ok">✓ Notion conectado</h1><p>Workspace <strong>${escapeHtml(String(wsName))}</strong> conectado ao Segundo Cérebro. A indexação começa em breve.</p>`,
        ),
      );
    } catch (e: any) {
      console.error(`[notion-onboard] FAILED: ${e?.message ?? e}`);
      res.status(500).type("html").send(page("Falha", `<h1 class="bad">Falha ao conectar</h1><p>${escapeHtml(e?.message ?? "erro desconhecido")}</p>`));
    }
  });

  return router;
}
