// src/rag/indexer.ts
import { fetchWorkspaceDocuments, chunkId } from "./notion-source.js";
import { fetchGranolaDocuments } from "./granola-source.js";
import { fetchCalendarDocuments } from "./calendar-source.js";
import { fetchIcsCalendarDocuments, hasIcsCalendars } from "./calendar-ics-source.js";
import { hasCreds as hasGoogleCreds } from "../google/oauth.js";
import { chunkText } from "./chunker.js";
import { batchEmbed } from "./embeddings.js";
import { upsertChunks, deleteBySource, pruneOrphans, getSyncState, setSyncState } from "./storage.js";
import { nextGranolaCursor } from "./granola-cursor.js";
import type { ChunkWithEmbedding, IndexableDocument, Workspace } from "./types.js";

// F.2.3: re-export the pure cursor helper (extracted to ./granola-cursor.js so
// it is unit-testable without dragging in the Notion client at import time).
export { nextGranolaCursor };

interface IndexerStats {
  documents: number;
  chunks: number;
  apiCalls: number;
  workspaces: Record<string, { documents: number; chunks: number }>;
  granola: Record<string, { documents: number; chunks: number }>;
  calendar?: { documents: number; chunks: number };
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
    // F.2.3: every live source_id seen this pass — used to prune orphans on a
    // full pass. Archived/trashed pages are deleted on sight and excluded.
    const liveIds: string[] = [];
    const archivedIds: string[] = [];

    try {
      for await (const doc of fetchWorkspaceDocuments({
        workspace: wsName,
        modifiedSince: opts.fullReindex ? undefined : lastSync,
        onArchived: (id) => archivedIds.push(id),
      })) {
        wsDocs++;
        const docChunks = await indexDocument(doc);
        docsToReplace.push(doc.source_id);
        liveIds.push(doc.source_id);
        wsChunks.push(...docChunks);
      }

      for (const id of docsToReplace) {
        await deleteBySource("notion", id);
      }
      // F.2.3: delete-on-sight any page reported archived/in_trash, even on a
      // delta pass (the orphan prune below only runs on full passes).
      for (const id of archivedIds) {
        await deleteBySource("notion", id);
      }
      await upsertChunks(wsChunks);
      // F.2.3: on a full pass, drop chunks for pages that no longer exist
      // upstream (orphans), scoped to this workspace's notion namespace.
      if (opts.fullReindex) {
        const pruned = await pruneOrphans("notion", wsName, liveIds);
        if (pruned > 0) console.log(`[indexer] workspace=${wsName} pruned ${pruned} orphan chunks`);
      }
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

    let docs = 0;
    const chunks: ChunkWithEmbedding[] = [];
    const docsToReplace: string[] = [];
    const liveIds: string[] = [];
    // F.2.3: collect each note's upstream created_at so the persisted cursor
    // advances to max(created_at) rather than wall-clock time.
    const seenNotes: Array<{ created_at?: string | null }> = [];

    try {
      for await (const doc of fetchGranolaDocuments({
        workspace: feed.workspace,
        tokenEnv: feed.tokenEnv,
        modifiedSince: opts.fullReindex ? undefined : lastSync,
      })) {
        docs++;
        const docChunks = await indexDocument(doc);
        docsToReplace.push(doc.source_id);
        liveIds.push(doc.source_id);
        seenNotes.push({ created_at: doc.metadata.created_at as string | undefined });
        chunks.push(...docChunks);
      }

      for (const id of docsToReplace) {
        await deleteBySource("granola", id);
      }
      await upsertChunks(chunks);
      // F.2.3: on a full pass, prune orphans within this workspace's granola
      // namespace (workspace is required for granola — chunks of different
      // workspaces share the bare source_type "granola").
      if (opts.fullReindex) {
        const pruned = await pruneOrphans("granola", feed.workspace, liveIds);
        if (pruned > 0) console.log(`[indexer] granola.${feed.workspace} pruned ${pruned} orphan chunks`);
      }
      // F.2.3: advance the cursor to max(created_at) of the listed notes, not
      // wall-clock. Edited notes are NOT caught by the created_after delta; the
      // nightly full reindex (F.2.4) is the only mechanism that re-fetches edits.
      // null (no notes listed) -> keep the prior cursor.
      const nextCursor = nextGranolaCursor(seenNotes);
      if (nextCursor) await setSyncState(sourceType, new Date(nextCursor));

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

  // ---- Calendar pass ----
  // Prefer iCal (GOOGLE_CAL_ICS): simple, account-agnostic, no Google Cloud.
  // Fall back to the Google-OAuth indexer only if iCal isn't configured.
  const useIcs = hasIcsCalendars();
  if (useIcs || hasGoogleCreds()) {
    const sourceType = "calendar-google";
    const lastSync = opts.fullReindex ? new Date(0) : await getSyncState(sourceType);
    const feedStarted = new Date();

    let docs = 0;
    const chunks: ChunkWithEmbedding[] = [];
    const docsToReplace: string[] = [];
    // F.2.3: calendar chunks of different workspaces share the bare source_type
    // "calendar"; prune must be scoped per workspace (inferred from the doc's
    // workspace, which calendar-source derives from owner_email / calendar id).
    const liveIdsByWorkspace = new Map<Workspace, string[]>();

    try {
      const calDocs = useIcs
        ? fetchIcsCalendarDocuments({ modifiedSince: opts.fullReindex ? undefined : lastSync })
        : fetchCalendarDocuments({ modifiedSince: opts.fullReindex ? undefined : lastSync });
      for await (const doc of calDocs) {
        docs++;
        const docChunks = await indexDocument(doc);
        docsToReplace.push(doc.source_id);
        if (doc.workspace) {
          const arr = liveIdsByWorkspace.get(doc.workspace) ?? [];
          arr.push(doc.source_id);
          liveIdsByWorkspace.set(doc.workspace, arr);
        }
        chunks.push(...docChunks);
      }

      for (const id of docsToReplace) {
        await deleteBySource("calendar", id);
      }
      await upsertChunks(chunks);
      // F.2.3: on a full pass, prune orphans per inferred workspace.
      if (opts.fullReindex) {
        for (const [ws, liveIds] of liveIdsByWorkspace) {
          const pruned = await pruneOrphans("calendar", ws, liveIds);
          if (pruned > 0) console.log(`[indexer] calendar.${ws} pruned ${pruned} orphan chunks`);
        }
      }
      await setSyncState(sourceType, feedStarted);

      stats.calendar = { documents: docs, chunks: chunks.length };
      stats.documents += docs;
      stats.chunks += chunks.length;
      stats.apiCalls += Math.ceil(chunks.length / 128);

      console.log(`[indexer] calendar (${useIcs ? "ics" : "google-oauth"}) documents=${docs} chunks=${chunks.length}`);
    } catch (err: any) {
      console.error(`[indexer] calendar FAILED:`, err.message ?? err);
      stats.calendar = { documents: docs, chunks: chunks.length };
    }
  } else {
    console.log("[indexer] calendar skipped — set GOOGLE_CAL_ICS or connect Google (/google/connect)");
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
