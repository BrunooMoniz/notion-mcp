// src/rag/sources/runner.ts
// F2.2: the generic pass runner. Drives ANY Source through the same lifecycle
// the three built-in passes use: compute lastSync -> listDocuments ->
// indexDocument -> deleteBySource (replace) -> upsertChunks -> setSyncState ->
// recordRun. Fully dependency-injected so it is unit-testable with NO DB and NO
// Voyage key (pass fake deps); production gets the real storage + indexDocument
// by default.
//
// No orphan-prune here: pluggable sources (web) are curated/on-demand, so a
// document that disappears from the feed is left in place until it is replaced
// or explicitly removed — there is no upstream "full enumeration" to diff against.

import {
  deleteBySource as realDeleteBySource,
  upsertChunks as realUpsertChunks,
  getSyncState as realGetSyncState,
  setSyncState as realSetSyncState,
  recordRun as realRecordRun,
} from "../storage.js";
import type {
  ChunkWithEmbedding,
  IndexableDocument,
  Source,
  SourcePassOptions,
} from "../types.js";

// `indexDocument` is loaded LAZILY (dynamic import) so this module — and the
// generic runner — can be unit-tested with injected deps and NO env: the real
// transform reaches notion-source.js -> clients.js, which exits the process if
// the Notion PAT env vars are unset. Tests inject a fake indexDocument and never
// hit this path; production resolves it on first real run.
async function realIndexDocument(doc: IndexableDocument): Promise<ChunkWithEmbedding[]> {
  const mod = await import("../index-document.js");
  return mod.indexDocument(doc);
}

export interface SourcePassDeps {
  indexDocument: (doc: IndexableDocument) => Promise<ChunkWithEmbedding[]>;
  deleteBySource: (sourceType: string, sourceId: string) => Promise<void>;
  upsertChunks: (chunks: ChunkWithEmbedding[]) => Promise<void>;
  getSyncState: (key: string) => Promise<Date>;
  setSyncState: (key: string, ts: Date) => Promise<void>;
  recordRun: (r: {
    worker: string;
    source: string;
    ok: boolean;
    counts?: unknown;
    error?: string | null;
    startedAt: Date;
    endedAt: Date;
  }) => Promise<void>;
}

const defaultDeps: SourcePassDeps = {
  indexDocument: realIndexDocument,
  deleteBySource: realDeleteBySource,
  upsertChunks: realUpsertChunks,
  getSyncState: realGetSyncState,
  setSyncState: realSetSyncState,
  recordRun: realRecordRun,
};

export async function runSourcePass(
  source: Source,
  opts: SourcePassOptions,
  deps?: Partial<SourcePassDeps>,
): Promise<{ documents: number; chunks: number }> {
  const d: SourcePassDeps = { ...defaultDeps, ...deps };
  const startedAt = new Date();
  const fullReindex = !!opts.fullReindex;
  const lastSync = fullReindex ? new Date(0) : await d.getSyncState(source.name);

  let documents = 0;
  const chunks: ChunkWithEmbedding[] = [];
  const docsToReplace: string[] = [];

  try {
    for await (const doc of source.listDocuments({ fullReindex, modifiedSince: lastSync })) {
      documents++;
      const docChunks = await d.indexDocument(doc);
      docsToReplace.push(doc.source_id);
      chunks.push(...docChunks);
    }

    // Replace-on-write: drop the prior chunks for each seen document, then upsert.
    for (const id of docsToReplace) {
      await d.deleteBySource(source.sourceType, id);
    }
    await d.upsertChunks(chunks);
    await d.setSyncState(source.name, startedAt);

    await d.recordRun({
      worker: "indexer",
      source: source.name,
      ok: true,
      counts: { documents, chunks: chunks.length },
      startedAt,
      endedAt: new Date(),
    });

    return { documents, chunks: chunks.length };
  } catch (err: any) {
    await d.recordRun({
      worker: "indexer",
      source: source.name,
      ok: false,
      error: err?.message ?? String(err),
      counts: { documents, chunks: chunks.length },
      startedAt,
      endedAt: new Date(),
    });
    return { documents, chunks: chunks.length };
  }
}
