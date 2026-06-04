// src/oauth-tokens.ts
//
// PURE helpers for OAuth token lifecycle: expiry, refresh-token rotation, and
// revocation. No HTTP, no fs, no crypto side effects — every function takes its
// inputs explicitly (including `now` and a token-minting callback) so the logic
// is unit-testable in isolation. oauth.ts wires these into the Express router
// and the on-disk store.
//
// The store shape mirrors what is persisted to data/oauth-store.json, but these
// functions never read or write that file. Missing keys default to empty so an
// older store (access tokens only, no refresh/revocation) still works.

export interface AccessTokenRecord {
  token: string;
  client_id: string;
  scopes: string[];
  expires_at: number;
}

export interface RefreshTokenRecord {
  token: string;
  client_id: string;
  scopes: string[];
  expires_at: number;
}

export interface TokenStore {
  accessTokens: AccessTokenRecord[];
  refreshTokens: RefreshTokenRecord[];
  /** Set of revoked access-token AND refresh-token strings. */
  revoked: Set<string>;
}

/** Returns true when `expiresAt` is at or before `now` (expired/just-expired). */
export function isTokenExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

/**
 * Normalize a possibly-partial persisted store into a full TokenStore.
 * Backward compatible: a store that lacks `refreshTokens`/`revoked` (older
 * format with only `accessTokens`) yields empty collections for those keys.
 */
export function normalizeStore(raw: {
  accessTokens?: AccessTokenRecord[];
  refreshTokens?: RefreshTokenRecord[];
  revoked?: string[];
}): TokenStore {
  return {
    accessTokens: raw.accessTokens ?? [],
    refreshTokens: raw.refreshTokens ?? [],
    revoked: new Set(raw.revoked ?? []),
  };
}

/**
 * True if the given token string (access OR refresh) has been revoked, or if
 * every token bound to a client_id should be considered revoked.
 * Pass `{ token }` to check one token, or `{ clientId }` to ask whether that
 * client has any revocation marker covering the supplied token.
 */
export function isRevoked(store: TokenStore, token: string): boolean {
  return store.revoked.has(token);
}

/**
 * Look up + validate an access token: must exist, not be expired, not be
 * revoked. Returns the record or null. Backward compatible — an access token
 * with no associated refresh token still validates here.
 */
export function findValidAccessToken(
  store: TokenStore,
  token: string,
  now: number,
): AccessTokenRecord | null {
  if (isRevoked(store, token)) return null;
  const entry = store.accessTokens.find((t) => t.token === token);
  if (!entry) return null;
  if (isTokenExpired(entry.expires_at, now)) return null;
  return entry;
}

/**
 * Validate a refresh token for the refresh_token grant: must exist, match the
 * presenting client, not be expired, not be revoked. Returns the record or a
 * reason string for the failure (so the caller can map it to an OAuth error).
 */
export function validateRefreshToken(
  store: TokenStore,
  refreshToken: string,
  clientId: string,
  now: number,
): { ok: true; record: RefreshTokenRecord } | { ok: false; reason: string } {
  const record = store.refreshTokens.find((t) => t.token === refreshToken);
  if (!record) return { ok: false, reason: "unknown_refresh_token" };
  if (isRevoked(store, refreshToken)) return { ok: false, reason: "revoked" };
  if (record.client_id !== clientId) return { ok: false, reason: "client_mismatch" };
  if (isTokenExpired(record.expires_at, now)) return { ok: false, reason: "expired" };
  return { ok: true, record };
}

export interface RotateResult {
  newAccess: AccessTokenRecord;
  newRefresh: RefreshTokenRecord;
  store: TokenStore;
}

/**
 * PURE refresh-token rotation. Validates `oldRefresh` (existence, client match,
 * expiry, revocation), then mints a new access token and a new refresh token
 * (preserving the original client_id + scopes), invalidates the old refresh
 * token, and returns the mutated store. Token strings and TTLs are supplied by
 * the caller via `mint` so this stays free of crypto/clock side effects.
 *
 * Invalidation strategy: the old refresh token is BOTH removed from
 * refreshTokens AND added to `revoked` (defense in depth against replay).
 *
 * Returns `{ error }` instead of throwing on validation failure.
 */
export function rotateRefresh(
  store: TokenStore,
  oldRefresh: string,
  clientId: string,
  now: number,
  mint: () => {
    accessToken: string;
    accessExpiresAt: number;
    refreshToken: string;
    refreshExpiresAt: number;
  },
): RotateResult | { error: string } {
  const validation = validateRefreshToken(store, oldRefresh, clientId, now);
  if (!validation.ok) return { error: validation.reason };

  const { scopes, client_id } = validation.record;
  const minted = mint();

  const newAccess: AccessTokenRecord = {
    token: minted.accessToken,
    client_id,
    scopes,
    expires_at: minted.accessExpiresAt,
  };
  const newRefresh: RefreshTokenRecord = {
    token: minted.refreshToken,
    client_id,
    scopes,
    expires_at: minted.refreshExpiresAt,
  };

  // Invalidate the old refresh token: drop it and mark it revoked.
  const refreshTokens = store.refreshTokens.filter((t) => t.token !== oldRefresh);
  refreshTokens.push(newRefresh);
  const revoked = new Set(store.revoked);
  revoked.add(oldRefresh);

  const nextStore: TokenStore = {
    accessTokens: [...store.accessTokens, newAccess],
    refreshTokens,
    revoked,
  };

  return { newAccess, newRefresh, store: nextStore };
}

/**
 * Revoke either a single token (access or refresh) or every token bound to a
 * client_id. Returns a new store with the affected token strings added to
 * `revoked`. Pure — no fs.
 */
export function revoke(
  store: TokenStore,
  target: { token?: string; clientId?: string },
): { store: TokenStore; revokedCount: number } {
  const revoked = new Set(store.revoked);
  let count = 0;

  if (target.token) {
    if (!revoked.has(target.token)) {
      revoked.add(target.token);
      count += 1;
    }
  }

  if (target.clientId) {
    for (const t of store.accessTokens) {
      if (t.client_id === target.clientId && !revoked.has(t.token)) {
        revoked.add(t.token);
        count += 1;
      }
    }
    for (const t of store.refreshTokens) {
      if (t.client_id === target.clientId && !revoked.has(t.token)) {
        revoked.add(t.token);
        count += 1;
      }
    }
  }

  return { store: { ...store, revoked }, revokedCount: count };
}
