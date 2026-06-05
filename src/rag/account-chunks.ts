// src/rag/account-chunks.ts
// F3.2b — tiny isolation helper, kept free of notion-source/clients imports so it
// stays unit-testable (clients.ts process.exit()s at load without env).
import type { ChunkWithEmbedding } from "./types.js";

/** Prefix each chunk id with the account so two accounts indexing the SAME Notion
 *  page (same source_id → same base chunk id) never collide on the brain_chunks
 *  PK. 'bruno' keeps unprefixed ids (its indexer never calls this). */
export function prefixChunkIds(
  chunks: ChunkWithEmbedding[],
  accountId: string,
): ChunkWithEmbedding[] {
  return chunks.map((c) => ({ ...c, id: `${accountId}:${c.id}`, account_id: accountId }));
}
