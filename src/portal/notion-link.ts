// src/portal/notion-link.ts
// 001-account-portal — bridge so a portal-initiated Notion connect reuses the
// EXISTING, already-registered redirect URI (/notion/callback) instead of a new
// one (Notion apps only allow a fixed redirect-URI allowlist). The portal stores
// state -> portal accountId here; the /notion/callback handler consumes it and,
// if present, associates the workspace to that portal account rather than minting
// a standalone notion:<workspace> identity. In-memory (single-instance server).
const STATE_TTL_MS = 10 * 60_000;
const states = new Map<string, { accountId: string; at: number }>();

function sweep(now: number): void {
  for (const [s, v] of states) if (now - v.at > STATE_TTL_MS) states.delete(s);
}

/** Record that this OAuth `state` belongs to a signed-in portal account. */
export function putPortalNotionState(state: string, accountId: string, now: number = Date.now()): void {
  sweep(now);
  states.set(state, { accountId, at: now });
}

/** Consume the state. Returns the portal accountId if it was portal-initiated and
 *  unexpired, else null (a standalone /notion/connect flow). Single-use. */
export function takePortalNotionState(state: string, now: number = Date.now()): string | null {
  sweep(now);
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state);
  if (now - entry.at > STATE_TTL_MS) return null;
  return entry.accountId;
}
