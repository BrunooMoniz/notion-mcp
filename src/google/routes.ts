// src/google/routes.ts
// Express routes that drive the one-time Google OAuth setup.
//   GET /google/connect  → returns a "Connect Google" page; on click, redirects to Google
//   GET /google/callback → exchanges the code, saves refresh_token to disk

import { Router } from "express";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { authUrl, exchangeCode, exchangeCodeRaw, loadCreds, redirectUri, SCOPES } from "./oauth.js";
import { takePortalGoogleState } from "../portal/google-link.js";
import { addGoogleAccount } from "./google-accounts.js";

const pendingStates = new Map<string, number>(); // state → expires_at
const STATE_TTL_MS = 10 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v < now) pendingStates.delete(k);
  }
}, 60_000);

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m] as string),
  );
}

function verifyAdminPassword(candidate: string): boolean {
  const env = process.env.OAUTH_PASSWORD_HASH;
  if (!env) return false;
  const [saltHex, hashHex] = env.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const hash = Buffer.from(hashHex, "hex");
    const derived = scryptSync(candidate, salt, 64);
    return timingSafeEqual(derived, hash);
  } catch {
    return false;
  }
}

export function createGoogleRouter(): Router {
  const router = Router();

  // Step 1: GET /google/connect → consent page (asks for admin password)
  router.get("/google/connect", (req, res) => {
    const existing = loadCreds();
    const existingNote = existing
      ? `<p style="color:#888;font-size:.9em">Já existe um refresh token salvo (${escape(existing.granted_email ?? "conta desconhecida")}). Conectar de novo vai substituir.</p>`
      : "";
    res.type("html").send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Connect Google Calendar</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;}
.card{background:#16213e;border-radius:12px;padding:40px;max-width:460px;width:100%;}
h1{font-size:1.4em;margin-bottom:8px;color:#fff;}
.sub{color:#888;margin-bottom:16px;font-size:.9em;}
input[type=password]{width:100%;padding:10px 14px;border-radius:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:1em;margin-bottom:16px;}
button{width:100%;padding:12px;border-radius:8px;border:none;font-size:1em;cursor:pointer;background:#4caf50;color:#fff;font-weight:600;}
</style></head><body>
<div class="card">
<h1>Connect Google Calendar</h1>
<p class="sub">Vai pedir que você dê acesso de leitura aos seus calendários. O refresh token fica no servidor.</p>
${existingNote}
<form method="POST" action="/google/connect">
<input type="password" name="password" placeholder="Admin password" required>
<button type="submit">Iniciar conexão →</button>
</form>
</div></body></html>`);
  });

  // Step 2: POST /google/connect → verify password, redirect to Google
  router.post("/google/connect", (req, res) => {
    const password = (req.body as { password?: string }).password ?? "";
    if (!verifyAdminPassword(password)) {
      res.status(403).type("html").send("<h2 style='font-family:sans-serif;padding:40px'>Senha inválida.</h2>");
      return;
    }
    const state = randomBytes(16).toString("base64url");
    pendingStates.set(state, Date.now() + STATE_TTL_MS);
    res.redirect(302, authUrl(state));
  });

  // Step 3: GET /google/callback → exchange code → save refresh token
  router.get("/google/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;
    if (error) {
      res.status(400).type("html").send(`<h2 style='font-family:sans-serif;padding:40px'>Google error: ${escape(error)}</h2>`);
      return;
    }
    // Portal multi-conta: state foi emitido por um usuário logado no portal.
    // Grava a conta Google no vault dele (não no arquivo único legado).
    if (code && state) {
      const portalAccount = takePortalGoogleState(state);
      if (portalAccount) {
        try {
          const creds = await exchangeCodeRaw(code);
          if (!creds.granted_email) throw new Error("não consegui identificar o email da conta Google");
          await addGoogleAccount(portalAccount, {
            email: creds.granted_email,
            refresh_token: creds.refresh_token,
            scopes: SCOPES,
          });
          console.log(`[google-oauth] portal account ${portalAccount} connected ${creds.granted_email}`);
          res
            .type("html")
            .send(
              `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Conectado</title></head><body style="font-family:sans-serif;padding:40px;background:#1a1a2e;color:#e0e0e0"><h1 style="color:#4caf50">✅ Google conectado</h1><p>Conta: <code>${escape(creds.granted_email)}</code>. Pode fechar esta aba e voltar ao portal.</p></body></html>`,
            );
        } catch (err: any) {
          console.error("[google-oauth] portal callback failed:", err);
          res
            .status(500)
            .type("html")
            .send(`<h2 style='font-family:sans-serif;padding:40px'>Falha: ${escape(err.message ?? String(err))}</h2>`);
        }
        return;
      }
    }
    if (!code || !state || !pendingStates.has(state)) {
      res.status(400).type("html").send("<h2 style='font-family:sans-serif;padding:40px'>Bad state/code.</h2>");
      return;
    }
    pendingStates.delete(state);
    try {
      const creds = await exchangeCode(code);
      console.log(`[google-oauth] connected ${creds.granted_email ?? "(no email)"}`);
      res.type("html").send(`<!DOCTYPE html>
<html><head><title>Connected</title>
<style>body{font-family:sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;}
.card{background:#16213e;border-radius:12px;padding:40px;max-width:460px;}</style></head>
<body><div class="card">
<h1 style="color:#4caf50">✅ Conectado!</h1>
<p>Refresh token salvo. O brain-indexer vai puxar seus calendários no próximo cron tick (no máximo em 1h).</p>
<p style="color:#888;font-size:.9em">Conta: <code>${escape(creds.granted_email ?? "?")}</code></p>
<p>Pode fechar essa aba.</p>
</div></body></html>`);
    } catch (err: any) {
      console.error("[google-oauth] callback failed:", err);
      res.status(500).type("html").send(`<h2 style='font-family:sans-serif;padding:40px'>Falha: ${escape(err.message ?? String(err))}</h2>`);
    }
  });

  // Step 4: GET /google/status → quick health probe
  router.get("/google/status", (_req, res) => {
    const creds = loadCreds();
    if (!creds) {
      res.json({ connected: false, redirect_uri: redirectUri() });
      return;
    }
    res.json({
      connected: true,
      granted_email: creds.granted_email,
      granted_at: new Date(creds.granted_at).toISOString(),
      access_token_expires_at: creds.access_token_expires_at
        ? new Date(creds.access_token_expires_at).toISOString()
        : null,
    });
  });

  return router;
}
