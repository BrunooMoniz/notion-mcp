// src/rag/__tests__/oauth-tokens.test.ts
// Lives in __tests__ so the `npm test` glob (src/rag/__tests__/*.test.ts) picks
// it up; the pure unit under test lives at src/oauth-tokens.ts. Under tsx +
// NodeNext a `.js` specifier resolves the sibling `.ts` source. No HTTP/fs/DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTokenExpired,
  normalizeStore,
  isRevoked,
  findValidAccessToken,
  validateRefreshToken,
  rotateRefresh,
  revoke,
  type TokenStore,
  type AccessTokenRecord,
  type RefreshTokenRecord,
} from "../../oauth-tokens.js";

const NOW = 1_000_000;

function access(token: string, opts: Partial<AccessTokenRecord> = {}): AccessTokenRecord {
  return {
    token,
    client_id: opts.client_id ?? "client-a",
    scopes: opts.scopes ?? ["personal"],
    expires_at: opts.expires_at ?? NOW + 10_000,
  };
}

function refresh(token: string, opts: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    token,
    client_id: opts.client_id ?? "client-a",
    scopes: opts.scopes ?? ["personal"],
    expires_at: opts.expires_at ?? NOW + 1_000_000,
  };
}

function store(partial: Partial<TokenStore> = {}): TokenStore {
  return {
    accessTokens: partial.accessTokens ?? [],
    refreshTokens: partial.refreshTokens ?? [],
    revoked: partial.revoked ?? new Set<string>(),
  };
}

// --- isTokenExpired (boundary) ---

test("isTokenExpired: now strictly before expiry -> not expired", () => {
  assert.equal(isTokenExpired(NOW + 1, NOW), false);
});

test("isTokenExpired: now exactly at expiry -> expired (boundary)", () => {
  assert.equal(isTokenExpired(NOW, NOW), true);
});

test("isTokenExpired: now after expiry -> expired", () => {
  assert.equal(isTokenExpired(NOW - 1, NOW), true);
});

// --- normalizeStore (backward compat) ---

test("normalizeStore: old store with only accessTokens -> empty refresh/revoked", () => {
  const s = normalizeStore({ accessTokens: [access("a1")] });
  assert.equal(s.accessTokens.length, 1);
  assert.deepEqual(s.refreshTokens, []);
  assert.equal(s.revoked.size, 0);
});

test("normalizeStore: completely empty object -> all empty", () => {
  const s = normalizeStore({});
  assert.deepEqual(s.accessTokens, []);
  assert.deepEqual(s.refreshTokens, []);
  assert.equal(s.revoked.size, 0);
});

test("normalizeStore: revoked array becomes a Set", () => {
  const s = normalizeStore({ revoked: ["x", "x", "y"] });
  assert.ok(s.revoked.has("x"));
  assert.ok(s.revoked.has("y"));
  assert.equal(s.revoked.size, 2);
});

// --- findValidAccessToken (backward compat: no refresh needed) ---

test("findValidAccessToken: valid access token with NO refresh token still validates", () => {
  const s = store({ accessTokens: [access("a1")] }); // no refreshTokens at all
  const found = findValidAccessToken(s, "a1", NOW);
  assert.ok(found);
  assert.equal(found?.token, "a1");
});

test("findValidAccessToken: expired access token -> null", () => {
  const s = store({ accessTokens: [access("a1", { expires_at: NOW - 1 })] });
  assert.equal(findValidAccessToken(s, "a1", NOW), null);
});

test("findValidAccessToken: revoked access token -> null", () => {
  const s = store({
    accessTokens: [access("a1")],
    revoked: new Set(["a1"]),
  });
  assert.equal(findValidAccessToken(s, "a1", NOW), null);
});

test("findValidAccessToken: unknown token -> null", () => {
  assert.equal(findValidAccessToken(store(), "nope", NOW), null);
});

// --- isRevoked ---

test("isRevoked: token in revoked set -> true", () => {
  assert.equal(isRevoked(store({ revoked: new Set(["t"]) }), "t"), true);
});

test("isRevoked: token not in set -> false", () => {
  assert.equal(isRevoked(store(), "t"), false);
});

// --- validateRefreshToken ---

test("validateRefreshToken: valid -> ok with record", () => {
  const s = store({ refreshTokens: [refresh("r1")] });
  const v = validateRefreshToken(s, "r1", "client-a", NOW);
  assert.equal(v.ok, true);
});

test("validateRefreshToken: unknown -> not ok", () => {
  const v = validateRefreshToken(store(), "r1", "client-a", NOW);
  assert.equal(v.ok, false);
});

test("validateRefreshToken: wrong client -> client_mismatch", () => {
  const s = store({ refreshTokens: [refresh("r1", { client_id: "client-a" })] });
  const v = validateRefreshToken(s, "r1", "client-b", NOW);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "client_mismatch");
});

test("validateRefreshToken: expired -> expired", () => {
  const s = store({ refreshTokens: [refresh("r1", { expires_at: NOW - 1 })] });
  const v = validateRefreshToken(s, "r1", "client-a", NOW);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "expired");
});

test("validateRefreshToken: revoked -> revoked", () => {
  const s = store({
    refreshTokens: [refresh("r1")],
    revoked: new Set(["r1"]),
  });
  const v = validateRefreshToken(s, "r1", "client-a", NOW);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "revoked");
});

// --- rotateRefresh ---

const mint = () => ({
  accessToken: "new-access",
  accessExpiresAt: NOW + 24 * 3600 * 1000,
  refreshToken: "new-refresh",
  refreshExpiresAt: NOW + 90 * 24 * 3600 * 1000,
});

test("rotateRefresh: issues new access + new refresh, preserves scopes", () => {
  const s = store({ refreshTokens: [refresh("r1", { scopes: ["personal", "nora"] })] });
  const result = rotateRefresh(s, "r1", "client-a", NOW, mint);
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.newAccess.token, "new-access");
  assert.equal(result.newRefresh.token, "new-refresh");
  assert.deepEqual(result.newAccess.scopes, ["personal", "nora"]);
  assert.deepEqual(result.newRefresh.scopes, ["personal", "nora"]);
});

test("rotateRefresh: invalidates the OLD refresh token (revoked + dropped)", () => {
  const s = store({ refreshTokens: [refresh("r1")] });
  const result = rotateRefresh(s, "r1", "client-a", NOW, mint);
  assert.ok(!("error" in result));
  if ("error" in result) return;
  // Old refresh is gone from the list...
  assert.equal(result.store.refreshTokens.some((t) => t.token === "r1"), false);
  // ...and explicitly revoked.
  assert.equal(isRevoked(result.store, "r1"), true);
  // The old refresh token no longer validates.
  const reuse = validateRefreshToken(result.store, "r1", "client-a", NOW);
  assert.equal(reuse.ok, false);
  // The new one does.
  assert.equal(validateRefreshToken(result.store, "new-refresh", "client-a", NOW).ok, true);
});

test("rotateRefresh: new access token is findable as valid", () => {
  const s = store({ refreshTokens: [refresh("r1")] });
  const result = rotateRefresh(s, "r1", "client-a", NOW, mint);
  if ("error" in result) return assert.fail("expected success");
  assert.ok(findValidAccessToken(result.store, "new-access", NOW));
});

test("rotateRefresh: rejects unknown/expired/revoked/mismatch with error", () => {
  // unknown
  assert.ok("error" in rotateRefresh(store(), "nope", "client-a", NOW, mint));
  // expired
  const expired = store({ refreshTokens: [refresh("r1", { expires_at: NOW - 1 })] });
  assert.ok("error" in rotateRefresh(expired, "r1", "client-a", NOW, mint));
  // mismatch
  const ok = store({ refreshTokens: [refresh("r1", { client_id: "client-a" })] });
  assert.ok("error" in rotateRefresh(ok, "r1", "client-b", NOW, mint));
});

// --- revoke ---

test("revoke: single token adds it to revoked", () => {
  const s = store({ accessTokens: [access("a1")] });
  const { store: next, revokedCount } = revoke(s, { token: "a1" });
  assert.equal(isRevoked(next, "a1"), true);
  assert.equal(revokedCount, 1);
  assert.equal(findValidAccessToken(next, "a1", NOW), null);
});

test("revoke: by client_id revokes ALL access + refresh tokens for that client", () => {
  const s = store({
    accessTokens: [
      access("a1", { client_id: "client-a" }),
      access("a2", { client_id: "client-a" }),
      access("a3", { client_id: "client-b" }),
    ],
    refreshTokens: [
      refresh("r1", { client_id: "client-a" }),
      refresh("r2", { client_id: "client-b" }),
    ],
  });
  const { store: next, revokedCount } = revoke(s, { clientId: "client-a" });
  assert.equal(revokedCount, 3); // a1, a2, r1
  assert.equal(isRevoked(next, "a1"), true);
  assert.equal(isRevoked(next, "a2"), true);
  assert.equal(isRevoked(next, "r1"), true);
  // client-b untouched
  assert.equal(isRevoked(next, "a3"), false);
  assert.equal(isRevoked(next, "r2"), false);
});

test("revoke: does not double-count an already-revoked token", () => {
  const s = store({ accessTokens: [access("a1")], revoked: new Set(["a1"]) });
  const { revokedCount } = revoke(s, { token: "a1" });
  assert.equal(revokedCount, 0);
});
