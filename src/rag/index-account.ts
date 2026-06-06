// src/rag/index-account.ts
// F3.2b + 001-account-portal — index ONE onboarded account's sources into the
// brain, ISOLATED from the built-in 'bruno' hourly indexer (runDeltaSync), which
// stays untouched. Runs at onboarding (fire-and-forget) and on portal /reindex.
//
// Notion: discovered via the account's vault token. Granola + iCal (added by a
// friend in the portal) are resolved from the vault here and indexed per account
// too (FR-010). Every source's chunks go through prefixChunkIds(accountId) +
// account-scoped deletes, so two accounts never collide and never leak.
//
// Token resolution happens via the request context: we run inside
// requestContext.run({accountId}) so getClient/getSearchClient/notionFetch in
// notion-source resolve THIS account's vault token.
import { requestContext } from "../context.js";
import { warmAccount } from "../account-tokens.js";
import { getAccountSecret } from "../secrets.js";
import { fetchWorkspaceDocuments } from "./notion-source.js";
import { fetchGranolaDocuments } from "./granola-source.js";
import { fetchIcsCalendarDocuments } from "./calendar-ics-source.js";
import { indexDocument } from "./index-document.js";
import {
  upsertChunks,
  deleteBySource,
  setSyncState,
  recordRun,
  pruneOrphans,
} from "./storage.js";
import { prefixChunkIds } from "./account-chunks.js";
import { FRIEND_WORKSPACE, accountIcalConfigs, ensureAccountWorkspace } from "./account-sources.js";
import type { ChunkWithEmbedding, Workspace } from "./types.js";

export async function indexAccount(accountId: string): Promise<{ documents: number; chunks: number }> {
  const workspaces = await warmAccount(accountId);
  let documents = 0;
  let chunks = 0;

  // ---- Notion pass (one per connected workspace) ----
  for (const ws of workspaces) {
    const startedAt = new Date();
    await requestContext.run({ authType: "bearer", scopes: "all", accountId }, async () => {
      const collected: ChunkWithEmbedding[] = [];
      const liveIds: string[] = [];
      const archivedIds: string[] = [];
      let wsDocs = 0;
      try {
        for await (const doc of fetchWorkspaceDocuments({
          workspace: ws as Workspace,
          onArchived: (id) => archivedIds.push(id),
        })) {
          doc.account_id = accountId;
          const docChunks = prefixChunkIds(await indexDocument(doc), accountId);
          await deleteBySource("notion", doc.source_id, accountId);
          collected.push(...docChunks);
          liveIds.push(doc.source_id);
          wsDocs++;
        }
        await upsertChunks(collected);
        for (const id of archivedIds) await deleteBySource("notion", id, accountId);
        const pruned = await pruneOrphans("notion", ws, liveIds, accountId);
        if (pruned > 0) console.log(`[index-account] ${accountId} ws=${ws} pruned ${pruned} orphans`);
        await setSyncState(`notion-${ws}`, startedAt, accountId);
        await recordRun({
          worker: "indexer",
          source: `notion-${ws}`,
          ok: true,
          counts: { documents: wsDocs, chunks: collected.length },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
        documents += wsDocs;
        chunks += collected.length;
        console.log(`[index-account] ${accountId} ws=${ws} documents=${wsDocs} chunks=${collected.length}`);
      } catch (err: any) {
        console.error(`[index-account] ${accountId} ws=${ws} FAILED: ${err?.message ?? err}`);
        await recordRun({
          worker: "indexer",
          source: `notion-${ws}`,
          ok: false,
          error: err?.message ?? String(err),
          counts: { documents: wsDocs, chunks: collected.length },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
      }
    });
  }

  // ---- Granola pass (one key per account, from the vault) ----
  const granolaKey = await getAccountSecret(accountId, "granola");
  if (granolaKey) {
    await ensureAccountWorkspace(accountId, FRIEND_WORKSPACE);
    const startedAt = new Date();
    await requestContext.run({ authType: "bearer", scopes: "all", accountId }, async () => {
      const collected: ChunkWithEmbedding[] = [];
      const liveIds: string[] = [];
      let gDocs = 0;
      try {
        for await (const doc of fetchGranolaDocuments({ token: granolaKey, workspace: FRIEND_WORKSPACE })) {
          doc.account_id = accountId;
          const docChunks = prefixChunkIds(await indexDocument(doc), accountId);
          await deleteBySource("granola", doc.source_id, accountId);
          collected.push(...docChunks);
          liveIds.push(doc.source_id);
          gDocs++;
        }
        await upsertChunks(collected);
        await pruneOrphans("granola", FRIEND_WORKSPACE, liveIds, accountId);
        await setSyncState(`granola-${FRIEND_WORKSPACE}`, startedAt, accountId);
        await recordRun({
          worker: "indexer",
          source: `granola-${FRIEND_WORKSPACE}`,
          ok: true,
          counts: { documents: gDocs, chunks: collected.length },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
        documents += gDocs;
        chunks += collected.length;
        console.log(`[index-account] ${accountId} granola documents=${gDocs} chunks=${collected.length}`);
      } catch (err: any) {
        console.error(`[index-account] ${accountId} granola FAILED: ${err?.message ?? err}`);
        await recordRun({
          worker: "indexer",
          source: `granola-${FRIEND_WORKSPACE}`,
          ok: false,
          error: err?.message ?? String(err),
          counts: { documents: gDocs, chunks: collected.length },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
      }
    });
  }

  // ---- iCal pass (many links per account, from the vault) ----
  const icalConfigs = accountIcalConfigs(await getAccountSecret(accountId, "ical"));
  if (icalConfigs.length > 0) {
    for (const ws of new Set(icalConfigs.map((c) => c.workspace))) {
      await ensureAccountWorkspace(accountId, ws);
    }
    const startedAt = new Date();
    await requestContext.run({ authType: "bearer", scopes: "all", accountId }, async () => {
      const collected: ChunkWithEmbedding[] = [];
      const liveByWs = new Map<string, string[]>();
      let cDocs = 0;
      try {
        for await (const doc of fetchIcsCalendarDocuments({ configs: icalConfigs })) {
          doc.account_id = accountId;
          const docChunks = prefixChunkIds(await indexDocument(doc), accountId);
          await deleteBySource("calendar", doc.source_id, accountId);
          collected.push(...docChunks);
          if (doc.workspace) {
            const arr = liveByWs.get(doc.workspace) ?? [];
            arr.push(doc.source_id);
            liveByWs.set(doc.workspace, arr);
          }
          cDocs++;
        }
        await upsertChunks(collected);
        for (const [ws, liveIds] of liveByWs) await pruneOrphans("calendar", ws, liveIds, accountId);
        await setSyncState("calendar-ics", startedAt, accountId);
        await recordRun({
          worker: "indexer",
          source: "calendar",
          ok: true,
          counts: { documents: cDocs, chunks: collected.length },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
        documents += cDocs;
        chunks += collected.length;
        console.log(`[index-account] ${accountId} calendar documents=${cDocs} chunks=${collected.length}`);
      } catch (err: any) {
        console.error(`[index-account] ${accountId} calendar FAILED: ${err?.message ?? err}`);
        await recordRun({
          worker: "indexer",
          source: "calendar",
          ok: false,
          error: err?.message ?? String(err),
          counts: { documents: cDocs, chunks: collected.length },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
      }
    });
  }

  return { documents, chunks };
}
