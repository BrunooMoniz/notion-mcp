// src/portal/sources.ts
// 001-account-portal — read/write a friend's source credentials through the
// existing encrypted vault (secrets.ts). iCal links are stored as a single JSON
// array under vault kind "ical" (multiple links, one blob); Granola is one key
// under kind "granola". Reads are always masked — a stored secret is never
// returned in plaintext (FR-008, SC-002).
import { randomBytes } from "node:crypto";
import { setAccountSecret, getAccountSecret, deleteAccountSecret } from "../secrets.js";

const ICAL_KIND = "ical";
const GRANOLA_KIND = "granola";

export interface IcalEntry {
  id: string;
  url: string;
  label: string;
  workspace: string;
}

export interface IcalMasked {
  id: string;
  label: string;
  workspace: string;
  masked_url: string;
}

/** Mask a secret URL: keep scheme+host, hide the path, reveal only a short tail. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = url.slice(-6);
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    if (url.length <= 8) return "••••";
    return `${url.slice(0, 4)}…${url.slice(-4)}`;
  }
}

/** Mask a token-like secret: reveal only the last 4 chars. */
export function maskToken(token: string): string {
  if (!token) return "";
  return `••••${token.slice(-4)}`;
}

export async function getIcalLinks(accountId: string): Promise<IcalEntry[]> {
  const raw = await getAccountSecret(accountId, ICAL_KIND);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as IcalEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveIcalLinks(accountId: string, entries: IcalEntry[]): Promise<void> {
  if (entries.length === 0) {
    await deleteAccountSecret(accountId, ICAL_KIND);
    return;
  }
  await setAccountSecret(accountId, ICAL_KIND, JSON.stringify(entries));
}

/** Add an iCal link; returns its generated id. */
export async function addIcalLink(
  accountId: string,
  input: { url: string; label?: string; workspace?: string },
): Promise<string> {
  const entries = await getIcalLinks(accountId);
  const id = randomBytes(4).toString("hex");
  entries.push({
    id,
    url: input.url,
    label: input.label ?? "",
    workspace: input.workspace ?? "personal",
  });
  await saveIcalLinks(accountId, entries);
  return id;
}

/** Edit one iCal link by id. Returns false if not found. */
export async function updateIcalLink(
  accountId: string,
  id: string,
  patch: { url?: string; label?: string; workspace?: string },
): Promise<boolean> {
  const entries = await getIcalLinks(accountId);
  const e = entries.find((x) => x.id === id);
  if (!e) return false;
  if (patch.url !== undefined) e.url = patch.url;
  if (patch.label !== undefined) e.label = patch.label;
  if (patch.workspace !== undefined) e.workspace = patch.workspace;
  await saveIcalLinks(accountId, entries);
  return true;
}

/** Remove one iCal link by id. Returns false if not found. */
export async function removeIcalLink(accountId: string, id: string): Promise<boolean> {
  const entries = await getIcalLinks(accountId);
  const next = entries.filter((x) => x.id !== id);
  if (next.length === entries.length) return false;
  await saveIcalLinks(accountId, next);
  return true;
}

/** Masked iCal inventory for display (never the secret URL). */
export async function listIcalMasked(accountId: string): Promise<IcalMasked[]> {
  const entries = await getIcalLinks(accountId);
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    workspace: e.workspace,
    masked_url: maskUrl(e.url),
  }));
}

/** Set or rotate the single Granola key. */
export async function setGranolaKey(accountId: string, key: string): Promise<void> {
  await setAccountSecret(accountId, GRANOLA_KIND, key);
}

export async function removeGranolaKey(accountId: string): Promise<void> {
  await deleteAccountSecret(accountId, GRANOLA_KIND);
}

/** Masked Granola state for display. */
export async function getGranolaMasked(
  accountId: string,
): Promise<{ set: boolean; masked: string | null }> {
  const key = await getAccountSecret(accountId, GRANOLA_KIND);
  return key ? { set: true, masked: maskToken(key) } : { set: false, masked: null };
}
