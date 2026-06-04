// src/rag/__tests__/migrate.test.ts
// Lives in __tests__ so the `npm test` glob (src/rag/__tests__/*.test.ts) picks
// it up; the pure logic under test lives in scripts/migrate-lib.mts. A `.mjs`
// specifier resolves to the `.mts` source under tsx/NodeNext (a `.js` one would
// not). No DB is touched by this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingMigrations } from "../../../scripts/migrate-lib.mjs";

test("pendingMigrations: returns files not yet applied, sorted", () => {
  assert.deepEqual(
    pendingMigrations(["0002_x.sql", "0001_init.sql"], ["0001_init.sql"]),
    ["0002_x.sql"],
  );
});

test("pendingMigrations: all applied -> empty", () => {
  assert.deepEqual(
    pendingMigrations(["0001_init.sql", "0002_x.sql"], ["0001_init.sql", "0002_x.sql"]),
    [],
  );
});

test("pendingMigrations: none applied -> all, sorted by zero-padded prefix", () => {
  assert.deepEqual(
    pendingMigrations(["0010_late.sql", "0002_x.sql", "0001_init.sql"], []),
    ["0001_init.sql", "0002_x.sql", "0010_late.sql"],
  );
});

test("pendingMigrations: empty input -> empty", () => {
  assert.deepEqual(pendingMigrations([], []), []);
});
