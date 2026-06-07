// src/google/google-accounts.ts
// Contas Google OAuth de um account (tenant), guardadas como um array JSON no
// vault criptografado (account_secrets, kind "google_oauth"), espelhando o
// padrão de iCal (src/portal/sources.ts). refresh_token NUNCA é retornado por
// rota/tool — só getRefreshToken (uso interno) e o resolver de token o tocam.
import { setAccountSecret, getAccountSecret, deleteAccountSecret } from "../secrets.js";

const GOOGLE_KIND = "google_oauth";

export interface GoogleAccountEntry {
  email: string;
  refresh_token: string;
  scopes: string[];
  connected_at: string; // ISO
}

export interface GoogleAccountMasked {
  email: string;
  connected_at: string;
}

export async function getGoogleAccounts(accountId: string): Promise<GoogleAccountEntry[]> {
  const raw = await getAccountSecret(accountId, GOOGLE_KIND);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as GoogleAccountEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveGoogleAccounts(accountId: string, entries: GoogleAccountEntry[]): Promise<void> {
  if (entries.length === 0) {
    await deleteAccountSecret(accountId, GOOGLE_KIND);
    return;
  }
  await setAccountSecret(accountId, GOOGLE_KIND, JSON.stringify(entries));
}

/** Conecta (ou reconecta) uma conta Google; upsert por email. */
export async function addGoogleAccount(
  accountId: string,
  creds: { email: string; refresh_token: string; scopes: string[]; connected_at?: string },
): Promise<void> {
  const entries = await getGoogleAccounts(accountId);
  const entry: GoogleAccountEntry = {
    email: creds.email,
    refresh_token: creds.refresh_token,
    scopes: creds.scopes,
    connected_at: creds.connected_at ?? new Date().toISOString(),
  };
  const idx = entries.findIndex((e) => e.email === creds.email);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  await saveGoogleAccounts(accountId, entries);
}

/** Remove uma conta Google por email. Retorna false se não existia. */
export async function removeGoogleAccount(accountId: string, email: string): Promise<boolean> {
  const entries = await getGoogleAccounts(accountId);
  const next = entries.filter((e) => e.email !== email);
  if (next.length === entries.length) return false;
  await saveGoogleAccounts(accountId, next);
  return true;
}

/** Uso interno do resolver de token. null se a conta/email não está conectada. */
export async function getRefreshToken(accountId: string, email: string): Promise<string | null> {
  const e = (await getGoogleAccounts(accountId)).find((x) => x.email === email);
  return e?.refresh_token ?? null;
}

/** Inventário para exibir no portal (sem refresh_token). */
export async function listGoogleAccountsMasked(accountId: string): Promise<GoogleAccountMasked[]> {
  return (await getGoogleAccounts(accountId)).map((e) => ({
    email: e.email,
    connected_at: e.connected_at,
  }));
}
