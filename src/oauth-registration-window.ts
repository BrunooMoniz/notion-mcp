// src/oauth-registration-window.ts
// Shared state for the OAuth Dynamic Client Registration (RFC 7591) enrollment
// window. Extracted from oauth.ts so the friend portal (src/portal/routes.ts)
// can open a short, self-service window WITHOUT importing the heavy, env-gated
// oauth.ts module (which process.exit()s when OAUTH_PASSWORD_HASH is unset, e.g.
// in the light dev server / unit tests).
//
// One window per process (module singleton): the operator admin endpoint and the
// portal both open the SAME window. Dynamic registration grants NOTHING on its
// own — the real gate is /oauth/authorize (operator password OR friend email +
// 6-digit code) — so a brief window is purely about who/when a client may be
// minted, not about data access.

let registrationWindowUntil = 0;

/** True while /oauth/register should accept new client registrations. */
export function isRegistrationOpen(now: number = Date.now()): boolean {
  return now < registrationWindowUntil;
}

/** Absolute epoch-ms the window is open until (0 = closed / never opened). */
export function registrationWindowExpiry(): number {
  return registrationWindowUntil;
}

/** Open (or extend) the window to now + ttlMs. EXTEND-ONLY: it never shortens an
 *  already-later expiry, so a brief portal click can't cut an operator's longer
 *  window short. Returns the resulting absolute expiry (epoch ms). */
export function openRegistrationWindow(ttlMs: number, now: number = Date.now()): number {
  const candidate = now + ttlMs;
  if (candidate > registrationWindowUntil) registrationWindowUntil = candidate;
  return registrationWindowUntil;
}

/** Force the window shut (operator close). */
export function closeRegistrationWindow(): void {
  registrationWindowUntil = 0;
}
