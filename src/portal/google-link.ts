// src/portal/google-link.ts
// 001-account-portal / Google multi-conta — guarda o vínculo state OAuth ->
// accountId do portal entre o redirect e o /google/callback. Espelha
// notion-link.ts. In-memory (servidor single-instance), single-use, TTL 10min.
const STATE_TTL_MS = 10 * 60_000;
const states = new Map<string, { accountId: string; at: number }>();

function sweep(now: number): void {
  for (const [s, v] of states) if (now - v.at > STATE_TTL_MS) states.delete(s);
}

export function putPortalGoogleState(state: string, accountId: string, now: number = Date.now()): void {
  sweep(now);
  states.set(state, { accountId, at: now });
}

export function takePortalGoogleState(state: string, now: number = Date.now()): string | null {
  sweep(now);
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state);
  if (now - entry.at > STATE_TTL_MS) return null;
  return entry.accountId;
}
