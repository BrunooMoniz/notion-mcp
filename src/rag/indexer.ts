// src/rag/indexer.ts
import { fetchWorkspaceDocuments, chunkId } from "./notion-source.js";
import { chunkText } from "./chunker.js";
import { batchEmbed } from "./embeddings.js";
import { upsertChunks, deleteBySource, getSyncState, setSyncState } from "./storage.js";
import type { ChunkWithEmbedding, IndexableDocument, Workspace } from "./types.js";

interface IndexerStats {
  documents: number;
  chunks: number;
  apiCalls: number;
  workspaces: Record<string, { documents: number; chunks: number }>;
  startedAt: Date;
  endedAt: Date;
}

interface WorkspaceConfig {
  name: Workspace;
  envVar: string;
}

const WORKSPACES: WorkspaceConfig[] = [
  { name: "personal", envVar: "NOTION_PERSONAL_TOKEN" },
  { name: "globalcripto", envVar: "NOTION_GLOBALCRIPTO_TOKEN" },
  { name: "nora", envVar: "NOTION_NORA_TOKEN" },
];

export async function runDeltaSync(opts: {
  fullReindex?: boolean;
  workspaces?: Workspace[];
} = {}): Promise<IndexerStats> {
  const startedAt = new Date();
  const targets = opts.workspaces
    ? WORKSPACES.filter((w) => opts.workspaces!.includes(w.name))
    : WORKSPACES;

  const stats: IndexerStats = {
    documents: 0,
    chunks: 0,
    apiCalls: 0,
    workspaces: {},
    startedAt,
    endedAt: new Date(),
  };

  for (const ws of targets) {
    const token = process.env[ws.envVar];
    if (!token) {
      console.warn(`[indexer] skipping workspace ${ws.name}: ${ws.envVar} not set`);
      continue;
    }

    const sourceType = `notion-${ws.name}`;
    const lastSync = opts.fullReindex ? new Date(0) : await getSyncState(sourceType);
    const wsStarted = new Date();

    let wsDocs = 0;
    const wsChunks: ChunkWithEmbedding[] = [];
    const docsToReplace: string[] = [];

    try {
      for await (const doc of fetchWorkspaceDocuments({
        workspace: ws.name,
        notionToken: token,
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

      stats.workspaces[ws.name] = { documents: wsDocs, chunks: wsChunks.length };
      stats.documents += wsDocs;
      stats.chunks += wsChunks.length;
      stats.apiCalls += Math.ceil(wsChunks.length / 128);

      console.log(
        `[indexer] workspace=${ws.name} documents=${wsDocs} chunks=${wsChunks.length}`,
      );
    } catch (err: any) {
      console.error(`[indexer] workspace ${ws.name} FAILED:`, err.message ?? err);
      stats.workspaces[ws.name] = { documents: wsDocs, chunks: wsChunks.length };
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
