// src/rag/__tests__/account-context.test.ts
// F3.0 — getAccountId() resolves the tenant for storage scoping. Mirrors the
// workspace model: out-of-request contexts fall back to the default account, and
// the value is taken from the trusted context, never from input.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAccountId,
  DEFAULT_ACCOUNT_ID,
  requestContext,
  type RequestContext,
} from "../../context.js";

test("getAccountId: no request context -> default account", () => {
  assert.equal(getAccountId(), DEFAULT_ACCOUNT_ID);
  assert.equal(getAccountId(), "bruno");
});

test("getAccountId: returns the context's accountId when set", () => {
  const ctx: RequestContext = { authType: "oauth", scopes: ["personal"], accountId: "acme" };
  requestContext.run(ctx, () => {
    assert.equal(getAccountId(), "acme");
  });
});

test("getAccountId: context without accountId -> default account", () => {
  const ctx: RequestContext = { authType: "bearer", scopes: "all" };
  requestContext.run(ctx, () => {
    assert.equal(getAccountId(), "bruno");
  });
});
