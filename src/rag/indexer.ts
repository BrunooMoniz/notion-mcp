// src/rag/indexer.ts
import { fetchPersonalDocuments, chunkId } from "./notion-source.js";
import { chunkText } from "./chunker.js";
import { batchEmbed } from "./embeddings.js";
import { upsertChunks, deleteBySource, getSyncState, setSyncState } from "./storage.js";
import type { ChunkWithEmbedding, IndexableDocument } from "./types.js";

interface IndexerStats {
  documents: number;
  chunks: number;
  apiCalls: number;
  startedAt: Date;
  endedAt: Date;
}

export async function runDeltaSync(opts: { fullReindex?: boolean } = {}): Promise<IndexerStats> {
  const startedAt = new Date();
  const sourceType = "notion-personal";
  const lastSync = opts.fullReindex ? new Date(0) : await getSyncState(sourceType);
  const token = process.env.NOTION_PERSONAL_TOKEN;
  if (!token) throw new Error("NOTION_PERSONAL_TOKEN not set");

  let documents = 0;
  const allChunks: ChunkWithEmbedding[] = [];
  const docsToReplace: string[] = [];

  for await (const doc of fetchPersonalDocuments({
    workspace: "personal",
    notionToken: token,
    modifiedSince: opts.fullReindex ? undefined : lastSync,
  })) {
    documents++;
    const docChunks = await indexDocument(doc);
    docsToReplace.push(doc.source_id);
    allChunks.push(...docChunks);
  }

  for (const id of docsToReplace) {
    await deleteBySource("notion", id);
  }
  await upsertChunks(allChunks);
  await setSyncState(sourceType, startedAt);

  return {
    documents,
    chunks: allChunks.length,
    apiCalls: Math.ceil(allChunks.length / 128),
    startedAt,
    endedAt: new Date(),
  };
}

async function indexDocument(doc: IndexableDocument): Promise<ChunkWithEmbedding[]> {
  const texts = chunkText(doc.text);
  if (texts.length === 0) return [];

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
