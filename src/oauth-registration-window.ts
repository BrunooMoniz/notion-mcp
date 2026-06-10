// src/oauth-registration-window.ts
// Shared state for the OAuth Dynamic Client Registration (RFC 7591) enrollment
// window. Now also stores the accountId that opened the window so
// GET /oauth/authorize can enforce that the browser session matches.
//
// One window per process (module singleton): the operator admin endpoint and the
// portal both open the SAME window. Dynamic registration grants NOTHING on its
// own — the real gate is /oauth/authorize (operator password OR friend email +
// 6-digit code) — so a brief window is purely about who/when a client may be
// minted, not about data access.

let registrationWindowUntil = 0;
let registrationWindowAccountId: string | null = null;

/** True while /oauth/register should accept new client registrations. */
export function isRegistrationOpen(now: number = Date.now()): boolean {
  return now < registrationWindowUntil;
}

/** Absolute epoch-ms the window is open until (0 = closed / never opened). */
export function registrationWindowExpiry(): number {
  return registrationWindowUntil;
}

/** The accountId that opened the current window, or null if none / no window. */
export function getWindowAccountId(): string | null {
  return registrationWindowAccountId;
}

/** Open (or extend) the window to now + ttlMs, optionally binding it to an
 *  accountId. EXTEND-ONLY for the expiry: it never shortens an already-later
 *  expiry, so a brief portal click can't cut an operator's longer window short.
 *  If accountId is provided (non-undefined) it overwrites whatever was stored.
 *  Passing undefined keeps the existing binding. Passing null explicitly clears it.
 *  Returns the resulting absolute expiry (epoch ms). */
export function openRegistrationWindow(
  ttlMs: number,
  accountId?: string | null,
  now: number = Date.now(),
): number {
  const candidate = now + ttlMs;
  if (candidate > registrationWindowUntil) registrationWindowUntil = candidate;
  if (accountId !== undefined) registrationWindowAccountId = accountId ?? null;
  return registrationWindowUntil;
}

/** Force the window shut (operator close). Also clears the bound accountId. */
export function closeRegistrationWindow(): void {
  registrationWindowUntil = 0;
  registrationWindowAccountId = null;
}
