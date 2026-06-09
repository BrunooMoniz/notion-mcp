// src/portal/__tests__/mcp-tokens.test.ts
// GET /portal/mcp-tokens  — list tokens (by hash id) for the session account.
// POST /portal/mcp-tokens/revoke — delete ONE token of the session account.
// Isolation: revoke of another account's token returns 404 and leaves data intact.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __setPoolForTest } from "../../rag/storage.js";
import {
  listMcpTokens,
  revokeMcpToken,
} from "../mcp-tokens.js";

// In-memory model for account_api_tokens rows
interface TokenRow {
  token_hash: string;
  account_id: string;
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

let rows: TokenRow[];

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      // List tokens for an account
      if (/SELECT token_hash.*FROM account_api_tokens/is.test(sql)) {
        const accountId = params[0];
        const found = rows
          .filter((r) => r.account_id === accountId)
          .map((r) => ({
            token_hash: r.token_hash,
            label: r.label,
            created_at: r.created_at,
            last_used_at: r.last_used_at,
          }));
        return { rows: found };
      }
      // Delete a specific token for a specific account
      if (/DELETE FROM account_api_tokens WHERE account_id=\$1 AND token_hash=\$2/i.test(sql)) {
        const accountId = params[0];
        const tokenHash = params[1];
        const before = rows.length;
        rows = rows.filter(
          (r) => !(r.account_id === accountId && r.token_hash === tokenHash),
        );
        return { rows: [], rowCount: before - rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

beforeEach(() => {
  rows = [];
  __setPoolForTest(memPool() as never);
});
afterEach(() => __setPoolForTest(null));

function seed(accountId: string, hash: string, label: string | null = null) {
  rows.push({
    token_hash: hash,
    account_id: accountId,
    label,
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_used_at: null,
  });
}

// --- listMcpTokens ---

test("listMcpTokens returns only tokens belonging to the given account", async () => {
  seed("account:a", "hash-a1", "portal");
  seed("account:a", "hash-a2", null);
  seed("account:b", "hash-b1", "portal");

  const list = await listMcpTokens("account:a");
  assert.equal(list.length, 2);
  assert.ok(list.every((t) => t.id === "hash-a1" || t.id === "hash-a2"));
  assert.ok(!list.some((t) => t.id === "hash-b1")); // account:b's token must not appear
});

test("listMcpTokens returns empty array when account has no tokens", async () => {
  seed("account:b", "hash-b1", "portal");
  const list = await listMcpTokens("account:a");
  assert.deepEqual(list, []);
});

test("listMcpTokens exposes id, name, created_at, last_used_at but NOT secrets", async () => {
  seed("account:a", "abc123", "claude-code");
  rows[0].last_used_at = new Date("2026-06-01T12:00:00Z");

  const [t] = await listMcpTokens("account:a");
  assert.equal(t.id, "abc123");
  assert.equal(t.name, "claude-code");
  assert.ok(t.created_at);
  assert.ok(t.last_used_at);
  // must not expose raw token
  assert.ok(!("token" in t));
});

// --- revokeMcpToken ---

test("revokeMcpToken removes the token and returns true", async () => {
  seed("account:a", "hash-x", "portal");
  const ok = await revokeMcpToken("account:a", "hash-x");
  assert.equal(ok, true);
  assert.equal(rows.length, 0);
});

test("revokeMcpToken returns false for unknown hash (no-op)", async () => {
  const ok = await revokeMcpToken("account:a", "nonexistent-hash");
  assert.equal(ok, false);
});

test("isolation: revokeMcpToken with another account's token hash returns false and leaves data intact", async () => {
  seed("account:owner", "owner-hash", "portal");
  // attacker session tries to revoke owner's token
  const ok = await revokeMcpToken("account:attacker", "owner-hash");
  assert.equal(ok, false);
  // owner's token must still exist
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_id, "account:owner");
});
