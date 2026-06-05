// src/rag/index-account.ts
// F3.2b — index ONE onboarded account's Notion into the brain, ISOLATED from the
// built-in 'bruno' hourly indexer (runDeltaSync), which stays untouched (zero risk
// to Bruno's pipeline). Runs at onboarding (fire-and-forget) and can be re-run.
//
// Token resolution happens via the request context: we run inside
// requestContext.run({accountId}) so getClient/getSearchClient/notionFetch in
// notion-source resolve THIS account's vault token. OAuth accounts discover via
// /v1/search (works); PAT accounts (search=0) yield nothing here — indexing PAT
// accounts by explicit page IDs is a later add.
import { requestContext } from "../context.js";
import { warmAccount } from "../account-tokens.js";
import { fetchWorkspaceDocuments } from "./notion-source.js";
import { indexDocument } from "./index-document.js";
import { upsertChunks, deleteBySource, setSyncState, recordRun, pruneOrphans } from "./storage.js";
import { prefixChunkIds } from "./account-chunks.js";
import type { ChunkWithEmbedding, Workspace } from "./types.js";

export async function indexAccount(accountId: string): Promise<{ documents: number; chunks: number }> {
  const workspaces = await warmAccount(accountId);
  let documents = 0;
  let chunks = 0;

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
        // Delete-on-sight archived pages, then prune orphans (account+workspace
        // scoped) so a re-index reflects upstream deletions.
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
  return { documents, chunks };
}
