// src/google/oauth.ts
// OAuth 2.0 client for Google APIs (calendar.readonly).
// Stores the long-lived refresh_token on disk; refreshes the access_token on demand.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const CREDS_PATH = join(DATA_DIR, "google-creds.json");

export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];
const SCOPE = SCOPES.join(" ");

export interface GoogleCreds {
  refresh_token: string;
  access_token?: string;
  access_token_expires_at?: number; // unix ms
  granted_at: number;
  granted_email?: string;
}

let inMemory: GoogleCreds | null = null;

export function loadCreds(): GoogleCreds | null {
  if (inMemory) return inMemory;
  try {
    const raw = readFileSync(CREDS_PATH, "utf8");
    inMemory = JSON.parse(raw) as GoogleCreds;
    return inMemory;
  } catch {
    return null;
  }
}

export function saveCreds(creds: GoogleCreds): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
  inMemory = creds;
}

export function hasCreds(): boolean {
  return loadCreds() !== null;
}

function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_ID not set");
  return v;
}

function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET not set");
  return v;
}

export function redirectUri(): string {
  const base = process.env.BASE_URL ?? "https://vps-1200754.tail30b723.ts.net";
  return `${base}/google/callback`;
}

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResp {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export async function exchangeCodeRaw(code: string): Promise<GoogleCreds> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json()) as TokenResp & { error?: string; error_description?: string };
  if (!resp.ok || data.error || !data.refresh_token) {
    throw new Error(
      `Google token exchange failed: ${data.error ?? "no_refresh_token"} ${data.error_description ?? ""}`,
    );
  }
  // Try to capture which Google account granted (best effort via userinfo)
  let granted_email: string | undefined;
  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (me.ok) {
      const u = (await me.json()) as { email?: string };
      granted_email = u.email;
    }
  } catch {
    /* ignore */
  }
  // Fallback: the primary calendar id IS the account email, and the calendar
  // scope is always granted here — covers grants made without the email scope.
  if (!granted_email) {
    try {
      const cal = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (cal.ok) {
        const c = (await cal.json()) as { id?: string };
        if (c.id && c.id.includes("@")) granted_email = c.id;
      }
    } catch {
      /* ignore */
    }
  }
  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    access_token_expires_at: Date.now() + (data.expires_in - 60) * 1000,
    granted_at: Date.now(),
    granted_email,
  };
}

export async function exchangeCode(code: string): Promise<GoogleCreds> {
  const creds = await exchangeCodeRaw(code);
  saveCreds(creds);
  return creds;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google refresh failed: ${data.error ?? "unknown"}`);
  }
  return { access_token: data.access_token, expires_in: data.expires_in ?? 3600 };
}

export async function getAccessToken(): Promise<string> {
  const creds = loadCreds();
  if (!creds) throw new Error("Google not connected — visit /google/connect first");
  if (creds.access_token && creds.access_token_expires_at && creds.access_token_expires_at > Date.now()) {
    return creds.access_token;
  }
  const { access_token, expires_in } = await refreshAccessToken(creds.refresh_token);
  saveCreds({ ...creds, access_token, access_token_expires_at: Date.now() + (expires_in - 60) * 1000 });
  return access_token;
}
