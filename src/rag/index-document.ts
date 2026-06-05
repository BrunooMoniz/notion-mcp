// src/rag/index-document.ts
// F2.2: the framework's core transform, extracted verbatim from indexer.ts so
// every source (the three built-in passes AND any pluggable Source) maps a
// document to chunks-with-embeddings through ONE code path: chunkText ->
// buildContextHeader -> batchEmbed -> map to ChunkWithEmbedding.

import { chunkId } from "./notion-source.js";
import { chunkText } from "./chunker.js";
import { buildContextHeader } from "./context-header.js";
import { batchEmbed } from "./embeddings.js";
import type { ChunkWithEmbedding, IndexableDocument } from "./types.js";

export async function indexDocument(doc: IndexableDocument): Promise<ChunkWithEmbedding[]> {
  const rawChunks = chunkText(doc.text);
  if (rawChunks.length === 0) return [];

  // Contextual retrieval: prepend a deterministic provenance header to each
  // chunk so the SAME header+chunk string is both embedded and stored.
  const header = buildContextHeader(doc);
  const texts = header
    ? rawChunks.map((c) => `${header}\n\n${c}`)
    : rawChunks;

  const embeddings = await batchEmbed(texts);
  return texts.map((text, idx) => ({
    id: chunkId(doc.source_id, idx),
    source_type: doc.source_type,
    source_id: doc.source_id,
    workspace: doc.workspace,
    db_name: doc.db_name,
    parent_url: doc.parent_url,
    chunk_index: idx,
    text,
    embedding: embeddings[idx],
    metadata: doc.metadata,
    source_updated: doc.source_updated,
  }));
}
