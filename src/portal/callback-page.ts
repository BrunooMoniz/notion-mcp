// src/portal/callback-page.ts
// 1.1 — Branded, standalone HTML pages shown after an OAuth callback completes
// (success or error). Opened in a new tab by the portal's connect buttons; the
// user reads the result and closes the tab to return to the portal.
//
// Design tokens: Geist via CDN, green accent #1f8b4c, Zinom logo SVG (same as
// portal/index.html ~396-404). HTML-escaping is mandatory — account name and
// workspace name come from the IdP and must never be rendered raw.

type OAuthProvider = "google" | "notion";

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[m] as string,
  );
}

/** Zinom logo SVG (extracted from portal/index.html) */
const LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 26 26" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="24" height="24" rx="7.5" fill="#1f8b4c"/>
  <path d="M8 8 H18 L8 18 H18" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="1.7" fill="#fff"/>
  <circle cx="18" cy="8" r="1.7" fill="#fff"/>
  <circle cx="8" cy="18" r="1.7" fill="#fff"/>
  <circle cx="18" cy="18" r="1.7" fill="#fff"/>
</svg>`;

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  notion: "Notion",
};

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Zinom</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-family:'Geist Sans',ui-sans-serif,system-ui,sans-serif;background:#0f0f0f;color:#e8e8e6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;padding:40px 36px;max-width:440px;width:100%;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:32px;font-weight:600;font-size:18px;color:#e8e8e6;letter-spacing:-.02em}
.icon{font-size:38px;margin-bottom:16px;display:block}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin-bottom:8px;color:#e8e8e6}
.sub{color:#888;font-size:14px;line-height:1.6;margin-bottom:24px}
.account{display:inline-block;background:#1f8b4c22;border:1px solid #1f8b4c44;border-radius:8px;padding:6px 14px;font-size:14px;color:#4cba7e;margin-bottom:20px;word-break:break-all}
.hint{color:#555;font-size:13px;margin-top:20px}
a{color:#4cba7e;text-decoration:none}a:hover{text-decoration:underline}
.accent{color:#1f8b4c}
</style>
</head>
<body>
<div class="card">
  <div class="brand">${LOGO_SVG}<span>Zinom</span></div>
  ${body}
</div>
</body>
</html>`;
}

/**
 * Build a success page for a completed OAuth connection.
 * `provider` is "google" | "notion"; `accountDisplay` is the email (Google) or
 * workspace name (Notion), HTML-escaped by this function.
 */
export function buildSuccessPage(provider: OAuthProvider, accountDisplay: string): string {
  const label = PROVIDER_LABEL[provider] ?? escapeHtml(provider);
  const safeAccount = escapeHtml(accountDisplay);
  const accountKind = provider === "google" ? "Conta" : "Workspace";
  return shell(`${label} conectado`, `
    <span class="icon">✅</span>
    <h1>${label} conectado</h1>
    <div class="account">${accountKind}: ${safeAccount}</div>
    <p class="sub">Pode fechar esta aba e voltar ao portal.</p>
  `);
}

/**
 * Build an error page for a failed OAuth connection.
 * `reason` is the error string from the IdP or internal error message (escaped).
 * `retryUrl` is the URL to start the flow again.
 */
export function buildErrorPage(provider: OAuthProvider, reason: string, retryUrl: string): string {
  const label = PROVIDER_LABEL[provider] ?? escapeHtml(provider);
  const safeReason = escapeHtml(reason);
  const safeRetry = escapeHtml(retryUrl);
  return shell(`Erro ao conectar ${label}`, `
    <span class="icon">❌</span>
    <h1>Erro ao conectar ${label}</h1>
    <p class="sub">${safeReason}</p>
    <a href="${safeRetry}">Tentar de novo →</a>
    <p class="hint">Se o problema persistir, feche esta aba e tente novamente pelo portal.</p>
  `);
}
