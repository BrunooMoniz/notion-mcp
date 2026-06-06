// src/portal/email.ts
// 001-account-portal — transactional email for magic links via the Resend HTTP
// API using the Node global fetch (zero npm deps, matching the repo's fetch-based
// integrations). In dev/test (PORTAL_EMAIL_DEV=1 or no RESEND_API_KEY) it does
// NOT send — it logs the link and records it so local flows and e2e can read it
// back instead of hitting a real inbox.
const RESEND_URL = "https://api.resend.com/emails";

let lastEmail: { to: string; link: string } | null = null;

/** Test/e2e seam: the last magic link "sent" (or captured in dev mode). */
export function __getLastEmail(): { to: string; link: string } | null {
  return lastEmail;
}

/** Dev mode = no real send. On when PORTAL_EMAIL_DEV=1 or no API key configured. */
export function isDevEmail(): boolean {
  return process.env.PORTAL_EMAIL_DEV === "1" || !process.env.RESEND_API_KEY;
}

function magicLinkHtml(link: string): string {
  return `<!doctype html><html><body style="font:16px/1.5 -apple-system,system-ui,sans-serif;color:#222">
  <h2 style="font-size:18px">🧠 Seu acesso ao Segundo Cérebro</h2>
  <p>Clique no botão abaixo para entrar. O link vale por 15 minutos e só funciona uma vez.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#1f8b4c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Entrar</a>
  </p>
  <p style="color:#888;font-size:13px">Se você não pediu este acesso, pode ignorar este e-mail.</p>
  </body></html>`;
}

let lastCode: { to: string; code: string } | null = null;
/** Test/e2e seam: the last login code "sent" (or captured in dev mode). */
export function __getLastCode(): { to: string; code: string } | null {
  return lastCode;
}

/** Send (or, in dev, capture) a 6-digit login code (for the Claude.ai OAuth
 *  authorize screen). Same dev-mode capture as the magic link. */
export async function sendLoginCodeEmail(
  to: string,
  code: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  lastCode = { to, code };
  if (isDevEmail()) {
    console.log(`[portal-email] DEV mode (no send) — login code for ${to}: ${code}`);
    return;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const from = process.env.PORTAL_EMAIL_FROM ?? "onboarding@resend.dev";
  const res = await doFetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: `Seu código de acesso: ${code}`,
      html: `<!doctype html><html><body style="font:16px/1.5 -apple-system,system-ui,sans-serif;color:#222">
      <h2 style="font-size:18px">🧠 Código de acesso ao Segundo Cérebro</h2>
      <p>Use este código para conectar seu assistente:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p>
      <p style="color:#888;font-size:13px">Vale por 10 minutos. Se você não pediu, ignore.</p>
      </body></html>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`resend send failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

/** Send (or, in dev, capture) the magic-link email. Throws on a real-send failure
 *  so the route can surface a retryable state. fetchImpl injectable for tests. */
export async function sendMagicLinkEmail(
  to: string,
  link: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  lastEmail = { to, link };
  if (isDevEmail()) {
    console.log(`[portal-email] DEV mode (no send) — magic link for ${to}: ${link}`);
    return;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const from = process.env.PORTAL_EMAIL_FROM ?? "onboarding@resend.dev";
  const res = await doFetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: "Seu link de acesso ao Segundo Cérebro",
      html: magicLinkHtml(link),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`resend send failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}
