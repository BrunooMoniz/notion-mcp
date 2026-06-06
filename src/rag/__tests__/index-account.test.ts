// src/rag/__tests__/index-account.test.ts
// F3.2b — isolation primitive: prefixChunkIds namespaces chunk ids by account so
// two accounts indexing the same Notion page never collide on the brain_chunks PK.
// 001-account-portal — per-account Granola/iCal wiring helpers (config parse +
// workspace registration). The full indexAccount() isn't unit-tested here because
// it calls indexDocument (embeddings) — same reason the rest of this file tests
// only the pure/wiring pieces.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prefixChunkIds } from "../account-chunks.js";
import { accountIcalConfigs, ensureAccountWorkspace, coerceWorkspace } from "../account-sources.js";
import { __setPoolForTest } from "../storage.js";
import type { ChunkWithEmbedding } from "../types.js";

function chunk(id: string): ChunkWithEmbedding {
  return {
    id,
    source_type: "notion",
    source_id: "page-1",
    workspace: "ws-1",
    db_name: null,
    parent_url: null,
    chunk_index: 0,
    text: "t",
    embedding: [0.1],
    metadata: {},
    source_updated: null,
  };
}

test("prefixChunkIds namespaces id and sets account_id", () => {
  const out = prefixChunkIds([chunk("abc"), chunk("def")], "notion:ws-1");
  assert.deepEqual(out.map((c) => c.id), ["notion:ws-1:abc", "notion:ws-1:def"]);
  assert.ok(out.every((c) => c.account_id === "notion:ws-1"));
});

test("two accounts indexing the same page get distinct ids (no PK collision)", () => {
  const a = prefixChunkIds([chunk("samehash")], "notion:A")[0];
  const b = prefixChunkIds([chunk("samehash")], "notion:B")[0];
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, "notion:A:samehash");
  assert.equal(b.id, "notion:B:samehash");
});

afterEach(() => __setPoolForTest(null));

test("accountIcalConfigs parses the vault iCal blob into source configs", () => {
  const raw = JSON.stringify([
    { id: "a1", url: "https://x/1.ics", label: "Pessoal", workspace: "personal" },
    { id: "a2", url: "https://x/2.ics", label: "", workspace: "nora" },
    { id: "a3", url: "" }, // dropped (no url)
  ]);
  const out = accountIcalConfigs(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { url: "https://x/1.ics", label: "Pessoal", workspace: "personal" });
  assert.equal(out[1].label, "Calendário"); // empty label defaulted
  assert.equal(out[1].workspace, "nora");
});

test("accountIcalConfigs is safe on null/garbage input", () => {
  assert.deepEqual(accountIcalConfigs(null), []);
  assert.deepEqual(accountIcalConfigs("not json"), []);
  assert.deepEqual(accountIcalConfigs(JSON.stringify({ not: "an array" })), []);
});

test("coerceWorkspace: known values pass, everything else falls back to personal", () => {
  assert.equal(coerceWorkspace("personal"), "personal");
  assert.equal(coerceWorkspace("globalcripto"), "globalcripto");
  assert.equal(coerceWorkspace("nora"), "nora");
  assert.equal(coerceWorkspace("evil-workspace"), "personal"); // arbitrary string coerced
  assert.equal(coerceWorkspace(undefined), "personal");
  assert.equal(coerceWorkspace(42 as unknown), "personal");
});

test("accountIcalConfigs coerces an arbitrary friend-supplied workspace to personal", () => {
  const raw = JSON.stringify([{ url: "https://x/1.ics", label: "L", workspace: "../etc/passwd" }]);
  const out = accountIcalConfigs(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].workspace, "personal"); // never the arbitrary string
});

test("ensureAccountWorkspace registers the workspace idempotently for the account", async () => {
  let sql = "";
  let params: unknown[] = [];
  __setPoolForTest({
    query: async (q: string, p: unknown[]) => {
      sql = q;
      params = p;
      return { rows: [], rowCount: 1 };
    },
  } as never);
  await ensureAccountWorkspace("friend:1", "personal");
  assert.match(sql, /INSERT INTO account_workspaces .* ON CONFLICT DO NOTHING/is);
  assert.deepEqual(params, ["friend:1", "personal"]);
});
