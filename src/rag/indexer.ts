// src/rag/indexer.ts
import { fetchWorkspaceDocuments, chunkId } from "./notion-source.js";
import { fetchGranolaDocuments } from "./granola-source.js";
import { chunkText } from "./chunker.js";
import { batchEmbed } from "./embeddings.js";
import { upsertChunks, deleteBySource, getSyncState, setSyncState } from "./storage.js";
import type { ChunkWithEmbedding, IndexableDocument, Workspace } from "./types.js";

interface IndexerStats {
  documents: number;
  chunks: number;
  apiCalls: number;
  workspaces: Record<string, { documents: number; chunks: number }>;
  granola: Record<string, { documents: number; chunks: number }>;
  startedAt: Date;
  endedAt: Date;
}

const WORKSPACES: Workspace[] = ["personal", "globalcripto", "nora"];

// Granola has two Bruno-side accounts: personal and corporate (globalcripto).
// Each maps to its own PAT (different env var) and tags chunks with the
// matching workspace so brain_search filters can use the same enum.
const GRANOLA_FEEDS: Array<{ workspace: Workspace; tokenEnv: string }> = [
  { workspace: "personal", tokenEnv: "GRANOLA_PERSONAL_TOKEN" },
  { workspace: "globalcripto", tokenEnv: "GRANOLA_GLOBALCRIPTO_TOKEN" },
];

export async function runDeltaSync(opts: {
  fullReindex?: boolean;
  workspaces?: Workspace[];
} = {}): Promise<IndexerStats> {
  const startedAt = new Date();
  const targets = opts.workspaces
    ? WORKSPACES.filter((w) => opts.workspaces!.includes(w))
    : WORKSPACES;

  const stats: IndexerStats = {
    documents: 0,
    chunks: 0,
    apiCalls: 0,
    workspaces: {},
    granola: {},
    startedAt,
    endedAt: new Date(),
  };

  // ---- Notion pass ----
  for (const wsName of targets) {
    const sourceType = `notion-${wsName}`;
    const lastSync = opts.fullReindex ? new Date(0) : await getSyncState(sourceType);
    const wsStarted = new Date();

    let wsDocs = 0;
    const wsChunks: ChunkWithEmbedding[] = [];
    const docsToReplace: string[] = [];

    try {
      for await (const doc of fetchWorkspaceDocuments({
        workspace: wsName,
        modifiedSince: opts.fullReindex ? undefined : lastSync,
      })) {
        wsDocs++;
        const docChunks = await indexDocument(doc);
        docsToReplace.push(doc.source_id);
        wsChunks.push(...docChunks);
      }

      for (const id of docsToReplace) {
        await deleteBySource("notion", id);
      }
      await upsertChunks(wsChunks);
      await setSyncState(sourceType, wsStarted);

      stats.workspaces[wsName] = { documents: wsDocs, chunks: wsChunks.length };
      stats.documents += wsDocs;
      stats.chunks += wsChunks.length;
      stats.apiCalls += Math.ceil(wsChunks.length / 128);

      console.log(
        `[indexer] workspace=${wsName} documents=${wsDocs} chunks=${wsChunks.length}`,
      );
    } catch (err: any) {
      console.error(`[indexer] workspace ${wsName} FAILED:`, err.message ?? err);
      stats.workspaces[wsName] = { documents: wsDocs, chunks: wsChunks.length };
    }
  }

  // ---- Granola pass ----
  for (const feed of GRANOLA_FEEDS) {
    if (opts.workspaces && !opts.workspaces.includes(feed.workspace)) continue;
    if (!process.env[feed.tokenEnv]) continue;

    const sourceType = `granola-${feed.workspace}`;
    const lastSync = opts.fullReindex ? new Date(0) : await getSyncState(sourceType);
    const feedStarted = new Date();

    let docs = 0;
    const chunks: ChunkWithEmbedding[] = [];
    const docsToReplace: string[] = [];

    try {
      for await (const doc of fetchGranolaDocuments({
        workspace: feed.workspace,
        tokenEnv: feed.tokenEnv,
        modifiedSince: opts.fullReindex ? undefined : lastSync,
      })) {
        docs++;
        const docChunks = await indexDocument(doc);
        docsToReplace.push(doc.source_id);
        chunks.push(...docChunks);
      }

      for (const id of docsToReplace) {
        await deleteBySource("granola", id);
      }
      await upsertChunks(chunks);
      await setSyncState(sourceType, feedStarted);

      stats.granola[feed.workspace] = { documents: docs, chunks: chunks.length };
      stats.documents += docs;
      stats.chunks += chunks.length;
      stats.apiCalls += Math.ceil(chunks.length / 128);

      console.log(
        `[indexer] granola.${feed.workspace} documents=${docs} chunks=${chunks.length}`,
      );
    } catch (err: any) {
      console.error(`[indexer] granola ${feed.workspace} FAILED:`, err.message ?? err);
      stats.granola[feed.workspace] = { documents: docs, chunks: chunks.length };
    }
  }

  stats.endedAt = new Date();
  return stats;
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
