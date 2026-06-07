// src/google/google-token.ts
// Resolve um access_token Google para um par (account, email): lê o refresh_token
// do vault daquele account, faz refresh sob demanda e cacheia em memória até
// expirar (espelha account-tokens.ts). resolveCalendarRef faz a GUARDA DE
// ISOLAMENTO: um calendar_ref só é aceito se seu email pertence a uma conta
// Google conectada por ESTE account — outro tenant não alcança a agenda.
import { getRefreshToken, getGoogleAccounts } from "./google-accounts.js";
import { refreshAccessToken } from "./oauth.js";
import { decodeCalendarRef } from "./calendar-ref.js";

interface Cached {
  token: string;
  expiresAt: number; // unix ms
}
const cache = new Map<string, Cached>(); // `${accountId}:${email}` -> token

/** Test seam: limpa o cache de tokens. */
export function __clearGoogleTokenCache(): void {
  cache.clear();
}

export async function getGoogleAccessTokenFor(accountId: string, email: string): Promise<string> {
  const key = `${accountId}:${email}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const refresh = await getRefreshToken(accountId, email);
  if (!refresh) {
    throw new Error(`Conta Google "${email}" não conectada nesta conta. Conecte no portal primeiro.`);
  }
  const { access_token, expires_in } = await refreshAccessToken(refresh);
  cache.set(key, { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 });
  return access_token;
}

export async function resolveCalendarRef(
  accountId: string,
  ref: string,
): Promise<{ email: string; calendarId: string; token: string }> {
  const { email, calendarId } = decodeCalendarRef(ref);
  const accounts = await getGoogleAccounts(accountId);
  if (!accounts.some((a) => a.email === email)) {
    throw new Error("Essa agenda não pertence a uma conta Google conectada nesta conta.");
  }
  const token = await getGoogleAccessTokenFor(accountId, email);
  return { email, calendarId, token };
}
