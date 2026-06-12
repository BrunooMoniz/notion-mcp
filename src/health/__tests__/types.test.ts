import { test } from "node:test";
import assert from "node:assert";
import { worstStatus } from "../types.js";

test("worstStatus: lista vazia → skip", () => {
  assert.strictEqual(worstStatus([]), "skip");
});

test("worstStatus: tudo ok → ok", () => {
  assert.strictEqual(worstStatus(["ok", "ok"]), "ok");
});

test("worstStatus: warn vence ok", () => {
  assert.strictEqual(worstStatus(["ok", "warn", "ok"]), "warn");
});

test("worstStatus: fail vence tudo", () => {
  assert.strictEqual(worstStatus(["warn", "fail", "ok", "skip"]), "fail");
});

test("worstStatus: tudo skip → skip", () => {
  assert.strictEqual(worstStatus(["skip", "skip"]), "skip");
});

test("worstStatus: skip não esconde ok", () => {
  assert.strictEqual(worstStatus(["skip", "ok"]), "ok");
});
