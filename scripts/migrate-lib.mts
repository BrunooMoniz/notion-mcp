// scripts/migrate-lib.mts
// Pure, DB-free migration logic. Kept in its own module so the unit test can
// import it without pulling in `pg` or `dotenv`. The runner (migrate.mts)
// re-uses this.
//
// Imported from tests as `migrate-lib.mjs` (a `.mjs` specifier resolves to this
// `.mts` source under tsx/NodeNext; a `.js` specifier would not).

/**
 * Given every migration filename and the set already applied, return the
 * not-yet-applied ones in sorted (zero-padded prefix) order.
 */
export function pendingMigrations(allFiles: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return allFiles
    .filter((f) => !done.has(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
