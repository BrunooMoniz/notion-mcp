// src/google/__tests__/google-link.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { putPortalGoogleState, takePortalGoogleState } from "../../portal/google-link.js";

test("put/take associa state ao accountId e é single-use", () => {
  const t0 = 1_000_000;
  putPortalGoogleState("st1", "acc:1", t0);
  assert.equal(takePortalGoogleState("st1", t0 + 1000), "acc:1");
  assert.equal(takePortalGoogleState("st1", t0 + 2000), null); // já consumido
});

test("state expirado retorna null", () => {
  const t0 = 1_000_000;
  putPortalGoogleState("st2", "acc:2", t0);
  assert.equal(takePortalGoogleState("st2", t0 + 11 * 60_000), null); // > TTL 10min
});

test("state desconhecido retorna null", () => {
  assert.equal(takePortalGoogleState("nope"), null);
});
