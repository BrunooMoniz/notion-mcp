// src/rag/granola-cursor.ts
// F.2.3: pure, dependency-free helper for advancing the persisted Granola sync
// cursor. Kept in its own module (no heavy transitive imports) so it is
// unit-testable without any credentials.

/**
 * The next persisted Granola cursor is the maximum `created_at` observed across
 * the listed notes (ISO-8601 strings sort lexically = chronologically).
 * Returns null when no note carries a valid created_at, in which case the
 * caller keeps the prior cursor.
 *
 * NOTE: Granola lists by `created_after`, and `created_at` never moves for an
 * EDITED note — so advancing the cursor to max(created_at) only avoids
 * re-listing already-seen new notes. Edited notes are NOT caught by the
 * created_after delta; the nightly full reindex (F.2.4) is the only mechanism
 * that re-fetches edits.
 */
export function nextGranolaCursor(
  notes: Array<{ created_at?: string | null }>,
): string | null {
  let max: string | null = null;
  for (const n of notes) {
    const c = n?.created_at;
    if (typeof c !== "string" || !c) continue;
    if (max === null || c > max) max = c;
  }
  return max;
}
