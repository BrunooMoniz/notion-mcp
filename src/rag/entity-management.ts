// src/rag/entity-management.ts
// Entity management operations: merge and rename.
// All operations are account-scoped — cross-account access returns error codes.
// Callers (routes.ts) translate error codes to HTTP 404 / 400 / 200.
import { getPool } from "./storage.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type MergeResult =
  | { ok: true }
  | { error: "keep_not_found" | "merge_not_found" };

export type RenameResult =
  | { ok: true; entity: { id: number; name: string; type: string; aliases: string[] } }
  | { error: "not_found" };

// ---------------------------------------------------------------------------
// mergeEntities
// ---------------------------------------------------------------------------
/**
 * Merge entity `merge_id` into `keep_id` for the given account.
 *
 * Steps (all account-scoped):
 *   1. Verify both entities belong to the account.
 *   2. Reassign entity_mentions from merge_id → keep_id, skipping chunk_ids
 *      already associated with keep_id (prevents UNIQUE (entity_id, chunk_id) violation).
 *   3. Add merge entity's name to keep entity's aliases (dedup via array_distinct).
 *   4. Delete merge entity (cascade removes any remaining mentions).
 *
 * Returns { ok: true } or { error: "keep_not_found" | "merge_not_found" }.
 */
export async function mergeEntities(
  accountId: string,
  keepId: number,
  mergeId: number,
): Promise<MergeResult> {
  const p = getPool();

  // 1. Verify keep entity belongs to account
  const { rows: keepRows } = await p.query<{ id: number; name: string; type: string; aliases: string[] }>(
    `SELECT id, name, type, aliases FROM entities WHERE id = $1 AND account_id = $2`,
    [keepId, accountId],
  );
  if (keepRows.length === 0) return { error: "keep_not_found" };
  const keepEntity = keepRows[0];

  // 2. Verify merge entity belongs to account
  const { rows: mergeRows } = await p.query<{ id: number; name: string; type: string; aliases: string[] }>(
    `SELECT id, name, type, aliases FROM entities WHERE id = $1 AND account_id = $2`,
    [mergeId, accountId],
  );
  if (mergeRows.length === 0) return { error: "merge_not_found" };
  const mergeEntity = mergeRows[0];

  // 3. Reassign mentions: update merge_id → keep_id, skipping existing chunk_ids
  //    This avoids duplicate (entity_id, chunk_id) violations.
  await p.query(
    `UPDATE entity_mentions
     SET entity_id = $1
     WHERE entity_id = $2
       AND chunk_id NOT IN (
         SELECT chunk_id FROM entity_mentions WHERE entity_id = $1
       )`,
    [keepId, mergeId],
  );

  // 4. Add merge entity's name (and its aliases) to keep entity's aliases
  const newAliases = [mergeEntity.name, ...mergeEntity.aliases];
  await p.query(
    `UPDATE entities
     SET aliases = array_distinct(aliases || $1::text[]),
         updated_at = now()
     WHERE id = $2 AND account_id = $3`,
    [newAliases, keepId, accountId],
  );

  // 5. Delete merge entity (CASCADE removes any remaining/orphaned mentions)
  await p.query(
    `DELETE FROM entities WHERE id = $1 AND account_id = $2`,
    [mergeId, accountId],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// renameEntity
// ---------------------------------------------------------------------------
/**
 * Rename and/or retype an entity for the given account.
 * When renaming, the old name is preserved in aliases.
 *
 * Returns { ok: true, entity } or { error: "not_found" }.
 */
export async function renameEntity(
  accountId: string,
  entityId: number,
  updates: { name?: string; type?: string },
): Promise<RenameResult> {
  const p = getPool();

  // 1. Verify entity belongs to account
  const { rows } = await p.query<{ id: number; name: string; type: string; aliases: string[] }>(
    `SELECT id, name, type, aliases FROM entities WHERE id = $1 AND account_id = $2`,
    [entityId, accountId],
  );
  if (rows.length === 0) return { error: "not_found" };
  const entity = rows[0];

  const newName = updates.name ?? entity.name;
  const newType = updates.type ?? entity.type;

  // 2. If name changed, preserve old name in aliases
  const aliases = entity.aliases ?? [];
  if (updates.name && updates.name !== entity.name && !aliases.includes(entity.name)) {
    aliases.push(entity.name);
  }

  // 3. UPDATE entity
  const { rows: updated } = await p.query<{ id: number; name: string; type: string; aliases: string[] }>(
    `UPDATE entities
     SET name = $1, type = $2, aliases = $3::text[], updated_at = now()
     WHERE id = $4 AND account_id = $5
     RETURNING id, name, type, aliases`,
    [newName, newType, aliases, entityId, accountId],
  );

  if (updated.length === 0) return { error: "not_found" };
  return { ok: true, entity: updated[0] };
}
