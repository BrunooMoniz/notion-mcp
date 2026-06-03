// src/rag/__tests__/getAllowedWorkspaces.test.ts
// Lives in __tests__ so the `npm test` glob (src/rag/__tests__/*.test.ts) picks
// it up; the unit under test lives at src/getAllowedWorkspaces.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAllowedWorkspaces,
  __setContextGetterForTest,
} from "../../getAllowedWorkspaces.js";

test("no context (cron/test/eval) -> null (no filter)", () => {
  __setContextGetterForTest(() => undefined);
  assert.equal(getAllowedWorkspaces(), null);
});

test('scopes "all" (bearer) -> null (no filter)', () => {
  __setContextGetterForTest(() => ({ scopes: "all" }) as never);
  assert.equal(getAllowedWorkspaces(), null);
});

test("scoped token -> the workspace array", () => {
  __setContextGetterForTest(() => ({ scopes: ["personal"] }) as never);
  assert.deepEqual(getAllowedWorkspaces(), ["personal"]);
});
