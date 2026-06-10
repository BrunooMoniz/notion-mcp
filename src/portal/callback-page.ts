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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin="anonymous">
<style>@import url('https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.2.6/index.css');</style>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#ffffff;--paper:#f7f6f3;--ink:#26241f;--ink-soft:#4a4740;--muted:#827d73;
  --line:#eae7df;--line-2:#e0ddd3;--accent:#1f8b4c;--accent-strong:#15633a;
  --accent-soft:#ecf5ef;--accent-ring:rgba(31,139,76,.18);
  --r:16px;--r-sm:11px;--r-xs:8px;
  --shadow:0 12px 32px -12px rgba(38,36,31,.18),0 4px 10px -6px rgba(38,36,31,.10);
  --sans:"Geist Variable","Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
}
html{font-family:var(--sans);background:var(--paper);color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:40px 36px;max-width:440px;width:100%;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:32px;font-weight:600;font-size:18px;color:var(--ink);letter-spacing:-.02em;text-decoration:none}
.status-icon{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;margin:0 auto 18px}
.status-icon.ok{background:var(--accent-soft);color:var(--accent)}
.status-icon.err{background:#fdf0ef;color:#c43030}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin-bottom:8px;color:var(--ink)}
.sub{color:var(--muted);font-size:14px;line-height:1.6;margin-bottom:20px}
.account{display:inline-block;background:var(--accent-soft);border:1px solid #d7e9de;border-radius:var(--r-xs);padding:6px 14px;font-size:13.5px;color:var(--accent-strong);font-weight:520;margin-bottom:16px;word-break:break-all}
.hint{color:var(--muted);font-size:13px;margin-top:18px;line-height:1.5}
a{color:var(--accent-strong);text-decoration:none;font-weight:520}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <a class="brand" href="/">${LOGO_SVG}<span>Zinom</span></a>
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
    <div class="status-icon ok" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
    </div>
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
    <div class="status-icon err" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </div>
    <h1>Erro ao conectar ${label}</h1>
    <p class="sub">${safeReason}</p>
    <a href="${safeRetry}">Tentar de novo</a>
    <p class="hint">Se o problema persistir, feche esta aba e tente novamente pelo portal.</p>
  `);
}
