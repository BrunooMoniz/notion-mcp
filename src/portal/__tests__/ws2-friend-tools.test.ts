// src/portal/__tests__/ws2-friend-tools.test.ts
// WS2 — friend Notion experience: per-account instructions/gating + the
// create-task payload builder. Pure unit tests (no DB, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskPagePayload } from "../task-write.js";
import { isOwnerContext, isOperatorToken, FRIEND_INSTRUCTIONS } from "../../mcp-account-config.js";

const OWNER_WS = ["personal", "globalcripto", "nora"] as const;

// --- buildTaskPagePayload (pure) --------------------------------------------

test("buildTaskPagePayload: title only -> data_source parent + Nome title, no extras", () => {
  const p = buildTaskPagePayload("ds-123", { title: "Comprar café" }) as any;
  assert.deepEqual(p.parent, { type: "data_source_id", data_source_id: "ds-123" });
  assert.equal(p.properties.Nome.title[0].text.content, "Comprar café");
  assert.equal(p.properties.Prazo, undefined);
  assert.equal(p.properties.Status, undefined);
  assert.equal(p.children, undefined);
});

test("buildTaskPagePayload: date -> Prazo.date.start (datetime passes through)", () => {
  const p = buildTaskPagePayload("ds-1", { title: "Reunião", date: "2026-06-09T20:00:00-03:00" }) as any;
  assert.deepEqual(p.properties.Prazo, { date: { start: "2026-06-09T20:00:00-03:00" } });
});

test("buildTaskPagePayload: status -> Status.select.name; note -> body paragraph", () => {
  const p = buildTaskPagePayload("ds-1", { title: "X", status: "A fazer", note: "detalhe" }) as any;
  assert.deepEqual(p.properties.Status, { select: { name: "A fazer" } });
  assert.equal(p.children[0].type, "paragraph");
  assert.equal(p.children[0].paragraph.rich_text[0].text.content, "detalhe");
});

test("buildTaskPagePayload: blank date/status are omitted (no empty props)", () => {
  const p = buildTaskPagePayload("ds-1", { title: "X", date: "   ", status: "" }) as any;
  assert.equal(p.properties.Prazo, undefined);
  assert.equal(p.properties.Status, undefined);
});

// --- isOwnerContext ----------------------------------------------------------

test("isOwnerContext: owner = no accountId, 'all' bearer, or default account", () => {
  assert.equal(isOwnerContext(undefined), true); // startup/tests
  assert.equal(isOwnerContext({ authType: "bearer", scopes: "all" }), true);
  assert.equal(isOwnerContext({ authType: "bearer", scopes: "all", accountId: "bruno" }), true);
});

test("isOwnerContext: a friend account is NOT owner", () => {
  assert.equal(isOwnerContext({ authType: "oauth", scopes: ["wsA"], accountId: "friend:abc" }), false);
  assert.equal(isOwnerContext({ authType: "bearer", scopes: ["notion:xyz"], accountId: "notion:xyz" }), false);
});

// FAIL-CLOSED: the regression that handed friend:e09 the owner tool set. A token
// reaching /mcp WITHOUT an accountId must NOT default to owner; owner requires a
// positive signal (bearer "all", default account, or explicit operator flag).
test("isOwnerContext: no-accountId OAuth token is NOT owner unless explicitly operator", () => {
  // friend token that lost its accountId — scopes are the friend's workspace UUIDs
  assert.equal(isOwnerContext({ authType: "oauth", scopes: ["313d872b-594c-81d7-aa05-000220a6ddc7"] }), false);
  // explicitly operator-flagged → owner (Bruno's Claude.ai)
  assert.equal(isOwnerContext({ authType: "oauth", scopes: ["personal"], isOperator: true }), true);
  // no flag, no accountId, unknown scopes → NOT owner (fail closed)
  assert.equal(isOwnerContext({ authType: "oauth", scopes: ["mystery-ws"] }), false);
});

// isOperatorToken — pure operator classifier the auth layer uses to set ctx.isOperator.
test("isOperatorToken: operator only by positive signal", () => {
  assert.equal(isOperatorToken({ scopes: "all" }, OWNER_WS), true);
  assert.equal(isOperatorToken({ scopes: ["personal", "nora"], kind: "operator" }, OWNER_WS), true);
  // legacy operator (pre-kind) bridged by scopes ⊆ the operator's known workspaces
  assert.equal(isOperatorToken({ scopes: ["personal", "globalcripto"] }, OWNER_WS), true);
  // friend (has accountId) is never operator, even with owner-looking scopes
  assert.equal(isOperatorToken({ scopes: ["personal"], accountId: "friend:x" }, OWNER_WS), false);
  // a workspace UUID in scopes → not the operator
  assert.equal(isOperatorToken({ scopes: ["313d872b-x", "personal"] }, OWNER_WS), false);
  // empty scopes → not operator
  assert.equal(isOperatorToken({ scopes: [] }, OWNER_WS), false);
});

// --- FRIEND_INSTRUCTIONS (no leakage of the owner's private structure) --------

test("FRIEND_INSTRUCTIONS never leaks Bruno's workspaces or partners", () => {
  const forbidden = ["globalcripto", "nora", "Caderno", "Jean", "Luigi", "Victor", "GlobalCripto", "Nora Finance"];
  for (const term of forbidden) {
    assert.ok(!FRIEND_INSTRUCTIONS.includes(term), `friend instructions must not mention "${term}"`);
  }
  // It also must not mention "personal" as a workspace name (case-insensitive word).
  assert.ok(!/\bpersonal\b/i.test(FRIEND_INSTRUCTIONS), 'must not name the "personal" workspace');
});

test("FRIEND_INSTRUCTIONS describes the friend's actual tools", () => {
  assert.ok(FRIEND_INSTRUCTIONS.includes("brain_search"));
  assert.ok(FRIEND_INSTRUCTIONS.includes("zinom_create_task"));
  assert.ok(/portugu[eê]s/i.test(FRIEND_INSTRUCTIONS));
});
