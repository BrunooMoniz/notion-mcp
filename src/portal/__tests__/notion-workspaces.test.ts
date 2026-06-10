// src/portal/__tests__/notion-workspaces.test.ts
// Multi-Notion lifecycle: list connected workspaces (with human names + dates),
// disconnect (purge the right secret kinds + the workspace row + indexed chunks),
// and the isolation gate (an account can't disconnect a workspace it doesn't own).
// Pure-logic against an in-memory pool stub (no live DB), mirroring sources.test.ts.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Vault needs a key before secrets.ts is exercised (deleteAccountSecret touches it
// indirectly through the pool, but importing the module is enough to require it).
process.env.SECRETS_KEY = "0".repeat(64);

import {
  listNotionWorkspaces,
  disconnectNotionWorkspace,
  accountOwnsWorkspace,
  NOTION_SECRET_KINDS,
  type NotionWorkspaceEntry,
} from "../notion-workspaces.js";
import { __setPoolForTest } from "../../rag/storage.js";

// In-memory model of the two tables this code touches.
interface Row {
  account_id: string;
  workspace: string;
  name: string | null;
  created_at: Date;
}

let workspaces: Row[]; // account_workspaces
let secrets: Set<string>; // `${account}|${kind}`
let chunks: Array<{ account_id: string; workspace: string; source_type: string }>; // brain_chunks

// account_secrets also stores kind so we can test connection_type derivation.
// Key format: `${account}|${kind}`, value is the encrypted secret.
let secretKinds: Map<string, string>; // `${account}|${kind}` -> dummy enc value

function memPool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      // --- account_workspaces ---
      if (/SELECT workspace, name, created_at FROM account_workspaces/i.test(sql)) {
        const rows = workspaces
          .filter((w) => w.account_id === params[0])
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return { rows };
      }
      if (/SELECT 1 FROM account_workspaces/i.test(sql)) {
        const found = workspaces.some((w) => w.account_id === params[0] && w.workspace === params[1]);
        return { rows: found ? [{ "?column?": 1 }] : [] };
      }
      if (/DELETE FROM account_workspaces/i.test(sql)) {
        const before = workspaces.length;
        workspaces = workspaces.filter((w) => !(w.account_id === params[0] && w.workspace === params[1]));
        return { rows: [], rowCount: before - workspaces.length };
      }
      // --- account_secrets: SELECT ... WHERE account_id=$1 AND kind=$2 ---
      // Covers both SELECT enc_value and SELECT kind patterns used for connection-type probing.
      if (/SELECT .* FROM account_secrets.*WHERE/i.test(sql)) {
        const v = secretKinds.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v, kind: params[1] }] : [] };
      }
      // --- account_secrets (deleteAccountSecret) ---
      if (/DELETE FROM account_secrets/i.test(sql)) {
        secretKinds.delete(`${params[0]}|${params[1]}`);
        secrets.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      // --- brain_chunks (deleteByAccountWorkspaceSource) ---
      if (/DELETE FROM brain_chunks/i.test(sql)) {
        const before = chunks.length;
        chunks = chunks.filter(
          (c) => !(c.account_id === params[0] && c.workspace === params[1] && c.source_type === params[2]),
        );
        return { rows: [], rowCount: before - chunks.length };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  workspaces = [];
  secrets = new Set();
  secretKinds = new Map();
  chunks = [];
  __setPoolForTest(memPool() as never);
});
afterEach(() => __setPoolForTest(null));

function seedConnected(account: string, ws: string, name: string | null, when: Date, kinds: string[]) {
  workspaces.push({ account_id: account, workspace: ws, name, created_at: when });
  for (const k of kinds) {
    secrets.add(`${account}|${k}`);
    secretKinds.set(`${account}|${k}`, "enc_dummy");
  }
}

test("list returns connected workspaces with human names + ISO dates, newest first", async () => {
  seedConnected("friend:a", "ws-old", "Cérebro do Bruno", new Date("2024-01-01T00:00:00Z"), [
    `notion_pat:ws-old`,
  ]);
  seedConnected("friend:a", "ws-new", "Workspace da Empresa", new Date("2024-06-01T00:00:00Z"), [
    `notion_access:ws-new`,
    `notion_refresh:ws-new`,
  ]);

  const list = await listNotionWorkspaces("friend:a");
  assert.equal(list.length, 2);
  // newest first
  assert.equal(list[0].workspace, "ws-new");
  assert.equal(list[0].name, "Workspace da Empresa");
  assert.equal(list[0].connected_at, new Date("2024-06-01T00:00:00Z").toISOString());
  assert.equal(list[1].name, "Cérebro do Bruno");
});

test("list returns null name when none was persisted (UUID fallback handled by UI)", async () => {
  seedConnected("friend:a", "ws-x", null, new Date("2024-01-01T00:00:00Z"), [`notion_access:ws-x`]);
  const list = await listNotionWorkspaces("friend:a");
  assert.equal(list[0].name, null);
});

test("disconnect purges the right secret kinds + workspace row + indexed chunks", async () => {
  seedConnected("friend:a", "ws-1", "A", new Date(), [
    `notion_access:ws-1`,
    `notion_refresh:ws-1`,
    `notion_pat:ws-1`,
  ]);
  // chunks: two for the target workspace, one for another workspace of the same
  // account (must survive), one for another account (must survive).
  chunks.push({ account_id: "friend:a", workspace: "ws-1", source_type: "notion" });
  chunks.push({ account_id: "friend:a", workspace: "ws-1", source_type: "notion" });
  chunks.push({ account_id: "friend:a", workspace: "ws-2", source_type: "notion" });
  chunks.push({ account_id: "friend:b", workspace: "ws-1", source_type: "notion" });

  const ok = await disconnectNotionWorkspace("friend:a", "ws-1");
  assert.equal(ok, true);

  // all three secret kinds for this workspace are gone
  for (const k of NOTION_SECRET_KINDS("ws-1")) {
    assert.ok(!secrets.has(`friend:a|${k}`), `secret ${k} should be deleted`);
  }
  // the workspace row is gone
  assert.ok(!workspaces.some((w) => w.account_id === "friend:a" && w.workspace === "ws-1"));
  // only the target workspace's chunks were purged; the others survive
  assert.equal(chunks.length, 2);
  assert.ok(chunks.some((c) => c.account_id === "friend:a" && c.workspace === "ws-2"));
  assert.ok(chunks.some((c) => c.account_id === "friend:b" && c.workspace === "ws-1"));
});

test("isolation: cannot disconnect a workspace another account owns", async () => {
  seedConnected("friend:owner", "ws-secret", "Owner WS", new Date(), [`notion_pat:ws-secret`]);
  chunks.push({ account_id: "friend:owner", workspace: "ws-secret", source_type: "notion" });

  // An attacker session (friend:attacker) tries to disconnect a workspace it does
  // not own. It must be refused and NOTHING of the owner's must be touched.
  const ok = await disconnectNotionWorkspace("friend:attacker", "ws-secret");
  assert.equal(ok, false);

  assert.ok(await accountOwnsWorkspace("friend:owner", "ws-secret"));
  assert.equal(await accountOwnsWorkspace("friend:attacker", "ws-secret"), false);
  // owner's secret, row, and chunk all intact
  assert.ok(secrets.has("friend:owner|notion_pat:ws-secret"));
  assert.ok(workspaces.some((w) => w.account_id === "friend:owner" && w.workspace === "ws-secret"));
  assert.equal(chunks.length, 1);
});

test("disconnect returns false for an unknown workspace (no-op)", async () => {
  const ok = await disconnectNotionWorkspace("friend:a", "does-not-exist");
  assert.equal(ok, false);
});

// 1.3: connection_type derived from secret kinds
test("listNotionWorkspaces includes connection_type=pat when notion_pat secret exists", async () => {
  seedConnected("friend:a", "ws-pat", "My WS", new Date(), ["notion_pat:ws-pat"]);
  const list = await listNotionWorkspaces("friend:a");
  assert.equal(list[0].connection_type, "pat");
});

test("listNotionWorkspaces includes connection_type=oauth when notion_access secret exists", async () => {
  seedConnected("friend:a", "ws-oauth", "My WS", new Date(), ["notion_access:ws-oauth", "notion_refresh:ws-oauth"]);
  const list = await listNotionWorkspaces("friend:a");
  assert.equal(list[0].connection_type, "oauth");
});

test("listNotionWorkspaces connection_type is null when no relevant secret exists", async () => {
  // Workspace row present but no notion secrets (edge case)
  workspaces.push({ account_id: "friend:a", workspace: "ws-bare", name: null, created_at: new Date() });
  const list = await listNotionWorkspaces("friend:a");
  assert.equal(list[0].connection_type, null);
});
