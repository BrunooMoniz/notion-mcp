// src/notion-routes.ts
// F3.2 — Express routes for Notion onboarding:
//   GET /notion/connect  -> issues a CSRF state and redirects to Notion authorize
//   GET /notion/callback -> validates state, exchanges code, onboards the account
// Additive + self-contained: when NOTION_OAUTH_CLIENT_ID/SECRET are unset these
// routes return 503 and nothing else in the server is affected.
import express from "express";
import { randomUUID } from "node:crypto";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  onboardAccount,
  validatePat,
  onboardPat,
} from "./notion-oauth.js";
import { escapeHtml } from "./rag/status.js";
import { indexAccount } from "./rag/index-account.js";
import { issueBearer } from "./account-bearer.js";

/** Render the post-connect page: issues a per-account MCP bearer (shown once) and
 *  the Claude Code setup command so the user can query their own brain. */
async function connectedPageHtml(displayName: string, accountId: string, baseUrl: string): Promise<string> {
  const token = await issueBearer(accountId, "onboarding");
  const mcpUrl = `${baseUrl}/mcp`;
  const cmd = `claude mcp add --transport http segundo-cerebro ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  return page(
    "Conectado",
    `<h1 class="ok">✓ Conectado</h1>
     <p><strong>${escapeHtml(displayName)}</strong> conectado ao Segundo Cérebro. A indexação do seu Notion já começou (pode levar alguns minutos).</p>
     <h2 style="font-size:16px;margin-top:24px">Pergunte ao seu cérebro pelo Claude Code</h2>
     <p>Rode no terminal:</p>
     <pre style="background:#8881;padding:12px;border-radius:8px;overflow:auto;font-size:13px;white-space:pre-wrap;word-break:break-all">${escapeHtml(cmd)}</pre>
     <p>Depois é só perguntar — ex.: <em>"busca no meu cérebro: ..."</em> (ferramenta <code>brain_search</code>).</p>
     <p style="color:#d83a3a;font-size:13px;margin-top:16px">⚠️ Guarde este token agora — ele aparece <strong>só uma vez</strong> e dá acesso de leitura ao seu cérebro.</p>`,
  );
}

// Kick off the first index for a freshly-onboarded account without blocking the
// HTTP response. Best-effort: failures are logged, never surfaced to the user.
// Dedupe: skip if an index for this account is already running (avoids double
// embed cost on repeat/concurrent onboards).
const indexInFlight = new Set<string>();
function kickoffIndex(accountId: string): void {
  if (indexInFlight.has(accountId)) {
    console.log(`[notion-onboard] index already in flight for ${accountId}, skipping`);
    return;
  }
  indexInFlight.add(accountId);
  void indexAccount(accountId)
    .then((r) => console.log(`[notion-onboard] indexed ${accountId}: ${r.documents} docs / ${r.chunks} chunks`))
    .catch((e) => console.error(`[notion-onboard] index ${accountId} failed: ${e?.message ?? e}`))
    .finally(() => indexInFlight.delete(accountId));
}

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

  // Landing page (the shareable onboarding link). Two paths: OAuth (recommended)
  // and an advanced "paste a Personal Access Token" form.
  const landing = () =>
    page(
      "Conectar — Segundo Cérebro",
      `<h1>🧠 Segundo Cérebro</h1>
       <p>Conecte seu Notion para começar. Recomendado: <strong>Conectar com Notion</strong> (1 clique, você escolhe o que compartilhar).</p>
       <p><a href="/notion/connect" style="display:inline-block;background:#1f8b4c;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">Conectar com Notion</a></p>
       <hr style="margin:28px 0;border:none;border-top:1px solid #8884">
       <details>
         <summary style="cursor:pointer;font-weight:600">Avançado: usar um Personal Access Token (cobertura total)</summary>
         <p style="color:#888;font-size:14px">Dá acesso de leitura a tudo que você vê no Notion, sem escolher páginas. Crie um em
           <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener">notion.so/profile/integrations</a>
           → aba <em>Personal Access Tokens</em> → copie o token (começa com <code>ntn_</code>).</p>
         <form method="POST" action="/notion/connect-pat">
           <input type="password" name="pat" placeholder="ntn_..." required autocomplete="off"
             style="width:100%;padding:10px;border:1px solid #8888;border-radius:6px;margin:8px 0">
           <button type="submit" style="background:#333;color:#fff;padding:10px 16px;border:none;border-radius:8px;font-weight:600;cursor:pointer">Conectar com token</button>
         </form>
       </details>`,
    );
  // 001-account-portal — the friend portal (static front, served at site root)
  // replaces this onboarding landing (FR-012). Keep /onboard/connect-pat working
  // as an advanced fallback, but send the landing routes to the portal.
  router.get("/onboard", (_req, res) => res.redirect("/"));

  router.post("/notion/connect-pat", async (req, res) => {
    const pat = typeof req.body?.pat === "string" ? req.body.pat.trim() : "";
    if (!pat) {
      res.status(400).type("html").send(page("Erro", `<p class="bad">Cole um Personal Access Token.</p>`));
      return;
    }
    try {
      const identity = await validatePat(pat);
      const { accountId } = await onboardPat(pat, identity);
      console.log(`[notion-onboard] PAT account=${accountId} ("${identity.name}") connected`);
      kickoffIndex(accountId);
      res.type("html").send(await connectedPageHtml(identity.name, accountId, BASE_URL));
    } catch (e: any) {
      console.error(`[notion-onboard] PAT failed: ${e?.message ?? e}`);
      res.status(400).type("html").send(page("Falha", `<h1 class="bad">Token inválido</h1><p>${escapeHtml(e?.message ?? "erro")}</p>`));
    }
  });

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
      kickoffIndex(accountId);
      res.type("html").send(await connectedPageHtml(String(wsName), accountId, BASE_URL));
    } catch (e: any) {
      console.error(`[notion-onboard] FAILED: ${e?.message ?? e}`);
      res.status(500).type("html").send(page("Falha", `<h1 class="bad">Falha ao conectar</h1><p>${escapeHtml(e?.message ?? "erro desconhecido")}</p>`));
    }
  });

  return router;
}
