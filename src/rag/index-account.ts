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
import { QuotaExceededError } from "../billing/usage.js";
import { prefixChunkIds } from "./account-chunks.js";
import { FRIEND_WORKSPACE, accountIcalConfigs } from "./account-sources.js";
import type { Workspace, IndexableDocument, ChunkWithEmbedding } from "./types.js";
import type { IcsCalendarConfig } from "./calendar-ics-source.js";

// ─── Dep-injection seam (test-only) ─────────────────────────────────────────

export interface IndexAccountDeps {
  warmAccount(accountId: string): Promise<string[]>;
  accountHasFeature(accountId: string, feature: string): Promise<boolean>;
  getAccountSecret(accountId: string, kind: string): Promise<string | null>;
  fetchWorkspaceDocuments(opts: {
    workspace: Workspace;
    onArchived: (id: string) => void;
  }): AsyncIterable<IndexableDocument>;
  fetchGranolaDocuments(opts: {
    token: string;
    workspace: Workspace;
  }): AsyncIterable<IndexableDocument>;
  fetchIcsCalendarDocuments(opts: {
    configs: IcsCalendarConfig[];
  }): AsyncIterable<IndexableDocument>;
  indexDocument(doc: IndexableDocument): Promise<ChunkWithEmbedding[]>;
  replaceDocumentChunks(
    sourceType: string,
    sourceId: string,
    accountId: string,
    chunks: ChunkWithEmbedding[],
  ): Promise<void>;
  deleteBySource(sourceType: string, sourceId: string, accountId: string): Promise<void>;
  setSyncState(key: string, ts: Date, accountId: string): Promise<void>;
  recordRun(run: {
    worker: string;
    source: string;
    ok: boolean;
    counts?: unknown;
    error?: string | null;
    startedAt: Date;
    endedAt: Date;
    accountId?: string;
  }): Promise<void>;
  pruneOrphans(
    sourceType: string,
    workspace: string,
    liveIds: string[],
    accountId: string,
  ): Promise<number>;
  ensureAccountWorkspace(accountId: string, workspace: string): Promise<void>;
  indexGcalOAuthForAccount(
    accountId: string,
    workspace: string,
  ): Promise<{ documents: number; chunks: number }>;
}

// Lazy real deps — loaded on demand so tests that inject don't boot clients.ts.
async function buildRealDeps(): Promise<IndexAccountDeps> {
  const [
    { warmAccount: wa },
    { accountHasFeature: ahf },
    { getAccountSecret: gas },
    { fetchWorkspaceDocuments: fwd },
    { fetchGranolaDocuments: fgd },
    { fetchIcsCalendarDocuments: ficd },
    { indexDocument: idoc },
    { replaceDocumentChunks: rdc, deleteBySource: dbs, setSyncState: sss, recordRun: rr, pruneOrphans: po },
    { ensureAccountWorkspace: eaw },
    { indexGcalOAuthForAccount: igoa },
  ] = await Promise.all([
    import("../account-tokens.js"),
    import("../billing/usage.js"),
    import("../secrets.js"),
    import("./notion-source.js"),
    import("./granola-source.js"),
    import("./calendar-ics-source.js"),
    import("./index-document.js"),
    import("./storage.js"),
    import("./account-sources.js"),
    import("./gcal-oauth-source.js"),
  ]);
  return {
    warmAccount: wa,
    accountHasFeature: ahf,
    getAccountSecret: gas,
    fetchWorkspaceDocuments: fwd,
    fetchGranolaDocuments: fgd,
    fetchIcsCalendarDocuments: ficd,
    indexDocument: idoc,
    replaceDocumentChunks: rdc,
    deleteBySource: dbs,
    setSyncState: sss,
    recordRun: rr,
    pruneOrphans: po,
    ensureAccountWorkspace: eaw,
    indexGcalOAuthForAccount: igoa,
  };
}

let _testDeps: IndexAccountDeps | null = null;

/** Test-only: inject deps or clear (null) after the test. */
export function __setIndexAccountDepsForTest(deps: IndexAccountDeps | null): void {
  _testDeps = deps;
}

async function getDeps(): Promise<IndexAccountDeps> {
  return _testDeps ?? buildRealDeps();
}

// ─── indexAccount ────────────────────────────────────────────────────────────

export async function indexAccount(accountId: string): Promise<{ documents: number; chunks: number }> {
  const deps = await getDeps();
  const workspaces = await deps.warmAccount(accountId);
  // Fase 3 billing — Granola + Calendar are paid features (Free indexes Notion
  // only). Owner/default account has all features.
  const canGranolaCalendar = await deps.accountHasFeature(accountId, "granolaCalendar");
  let documents = 0;
  let chunks = 0;

  // Bug #96 (3) — teto de chunks do plano. Quando uma fonte estoura o limite
  // (QuotaExceededError de replaceDocumentChunks), o run NÃO explode: a fonte
  // grava status_run com error="plan_limit" (counts parciais), as fontes ainda
  // não processadas gravam {skipped:"plan_limit"} sem rodar, e o run termina
  // graceful. O /portal/status propaga plan_limit para o front.
  let planLimitHit = false;
  const recordPlanLimitSkip = async (source: string): Promise<void> => {
    await deps.recordRun({
      worker: "indexer",
      source,
      ok: true,
      counts: { skipped: "plan_limit" },
      startedAt: new Date(),
      endedAt: new Date(),
      accountId,
    });
  };

  // ---- Notion pass (one per connected workspace) ----
  for (const ws of workspaces) {
    if (planLimitHit) {
      await recordPlanLimitSkip(`notion-${ws}`);
      continue;
    }
    const startedAt = new Date();
    await requestContext.run({ authType: "bearer", scopes: "all", accountId }, async () => {
      const liveIds: string[] = [];
      const archivedIds: string[] = [];
      let wsDocs = 0;
      let wsChunks = 0;
      try {
        for await (const doc of deps.fetchWorkspaceDocuments({
          workspace: ws as Workspace,
          onArchived: (id) => archivedIds.push(id),
        })) {
          doc.account_id = accountId;
          const docChunks = prefixChunkIds(await deps.indexDocument(doc), accountId);
          // Atomic per-document replace: an interruption mid-pass leaves every
          // already-processed document intact instead of emptying the brain.
          await deps.replaceDocumentChunks("notion", doc.source_id, accountId, docChunks);
          liveIds.push(doc.source_id);
          wsDocs++;
          wsChunks += docChunks.length;
        }
        for (const id of archivedIds) await deps.deleteBySource("notion", id, accountId);
        const pruned = await deps.pruneOrphans("notion", ws, liveIds, accountId);
        if (pruned > 0) console.log(`[index-account] ${accountId} ws=${ws} pruned ${pruned} orphans`);
        await deps.setSyncState(`notion-${ws}`, startedAt, accountId);
        await deps.recordRun({
          worker: "indexer",
          source: `notion-${ws}`,
          ok: true,
          counts: { documents: wsDocs, chunks: wsChunks },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
        documents += wsDocs;
        chunks += wsChunks;
        console.log(`[index-account] ${accountId} ws=${ws} documents=${wsDocs} chunks=${wsChunks}`);
      } catch (err: any) {
        const isPlanLimit = err instanceof QuotaExceededError;
        if (isPlanLimit) planLimitHit = true;
        console.error(`[index-account] ${accountId} ws=${ws} FAILED: ${err?.message ?? err}`);
        await deps.recordRun({
          worker: "indexer",
          source: `notion-${ws}`,
          ok: false,
          error: isPlanLimit ? "plan_limit" : (err?.message ?? String(err)),
          counts: { documents: wsDocs, chunks: wsChunks },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
      }
    });
  }

  // ---- Granola pass (one key per account, from the vault) ----
  const granolaKey =
    canGranolaCalendar && !planLimitHit ? await deps.getAccountSecret(accountId, "granola") : null;
  if (canGranolaCalendar && planLimitHit) {
    await recordPlanLimitSkip(`granola-${FRIEND_WORKSPACE}`);
  } else if (granolaKey) {
    await deps.ensureAccountWorkspace(accountId, FRIEND_WORKSPACE);
    const startedAt = new Date();
    await requestContext.run({ authType: "bearer", scopes: "all", accountId }, async () => {
      const liveIds: string[] = [];
      let gDocs = 0;
      let gChunks = 0;
      try {
        for await (const doc of deps.fetchGranolaDocuments({ token: granolaKey, workspace: FRIEND_WORKSPACE })) {
          doc.account_id = accountId;
          const docChunks = prefixChunkIds(await deps.indexDocument(doc), accountId);
          await deps.replaceDocumentChunks("granola", doc.source_id, accountId, docChunks);
          liveIds.push(doc.source_id);
          gDocs++;
          gChunks += docChunks.length;
        }
        await deps.pruneOrphans("granola", FRIEND_WORKSPACE, liveIds, accountId);
        await deps.setSyncState(`granola-${FRIEND_WORKSPACE}`, startedAt, accountId);
        await deps.recordRun({
          worker: "indexer",
          source: `granola-${FRIEND_WORKSPACE}`,
          ok: true,
          counts: { documents: gDocs, chunks: gChunks },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
        documents += gDocs;
        chunks += gChunks;
        console.log(`[index-account] ${accountId} granola documents=${gDocs} chunks=${gChunks}`);
      } catch (err: any) {
        const isPlanLimit = err instanceof QuotaExceededError;
        if (isPlanLimit) planLimitHit = true;
        console.error(`[index-account] ${accountId} granola FAILED: ${err?.message ?? err}`);
        await deps.recordRun({
          worker: "indexer",
          source: `granola-${FRIEND_WORKSPACE}`,
          ok: false,
          error: isPlanLimit ? "plan_limit" : (err?.message ?? String(err)),
          counts: { documents: gDocs, chunks: gChunks },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
      }
    });
  } else if (canGranolaCalendar) {
    // granola secret absent — record a skipped run so status_runs is never silent.
    await deps.recordRun({
      worker: "indexer",
      source: `granola-${FRIEND_WORKSPACE}`,
      ok: true,
      counts: { skipped: "no_credentials" },
      startedAt: new Date(),
      endedAt: new Date(),
      accountId,
    });
  }

  // ---- iCal pass (many links per account, from the vault) ----
  const icalConfigs =
    canGranolaCalendar && !planLimitHit
      ? accountIcalConfigs(await deps.getAccountSecret(accountId, "ical"))
      : [];
  if (canGranolaCalendar && planLimitHit) {
    await recordPlanLimitSkip("calendar");
  } else if (icalConfigs.length > 0) {
    for (const ws of new Set(icalConfigs.map((c) => c.workspace))) {
      await deps.ensureAccountWorkspace(accountId, ws);
    }
    const startedAt = new Date();
    await requestContext.run({ authType: "bearer", scopes: "all", accountId }, async () => {
      const liveByWs = new Map<string, string[]>();
      let cDocs = 0;
      let cChunks = 0;
      try {
        for await (const doc of deps.fetchIcsCalendarDocuments({ configs: icalConfigs })) {
          doc.account_id = accountId;
          const docChunks = prefixChunkIds(await deps.indexDocument(doc), accountId);
          await deps.replaceDocumentChunks("calendar", doc.source_id, accountId, docChunks);
          if (doc.workspace) {
            const arr = liveByWs.get(doc.workspace) ?? [];
            arr.push(doc.source_id);
            liveByWs.set(doc.workspace, arr);
          }
          cDocs++;
          cChunks += docChunks.length;
        }
        for (const [ws, liveIds] of liveByWs) await deps.pruneOrphans("calendar", ws, liveIds, accountId);
        await deps.setSyncState("calendar-ics", startedAt, accountId);
        await deps.recordRun({
          worker: "indexer",
          source: "calendar",
          ok: true,
          counts: { documents: cDocs, chunks: cChunks },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
        documents += cDocs;
        chunks += cChunks;
        console.log(`[index-account] ${accountId} calendar documents=${cDocs} chunks=${cChunks}`);
      } catch (err: any) {
        const isPlanLimit = err instanceof QuotaExceededError;
        if (isPlanLimit) planLimitHit = true;
        console.error(`[index-account] ${accountId} calendar FAILED: ${err?.message ?? err}`);
        await deps.recordRun({
          worker: "indexer",
          source: "calendar",
          ok: false,
          error: isPlanLimit ? "plan_limit" : (err?.message ?? String(err)),
          counts: { documents: cDocs, chunks: cChunks },
          startedAt,
          endedAt: new Date(),
          accountId,
        });
      }
    });
  } else if (canGranolaCalendar) {
    // ical secret absent — record a skipped run so status_runs is never silent.
    await deps.recordRun({
      worker: "indexer",
      source: "calendar",
      ok: true,
      counts: { skipped: "no_credentials" },
      startedAt: new Date(),
      endedAt: new Date(),
      accountId,
    });
  }

  // ---- Google OAuth calendar pass (many accounts per tenant, from vault) ----
  if (canGranolaCalendar && planLimitHit) {
    await recordPlanLimitSkip("gcal");
  } else if (canGranolaCalendar) {
    try {
      const gcalResult = await deps.indexGcalOAuthForAccount(accountId, FRIEND_WORKSPACE);
      documents += gcalResult.documents;
      chunks += gcalResult.chunks;
      if (gcalResult.documents > 0 || gcalResult.chunks > 0) {
        console.log(
          `[index-account] ${accountId} gcal documents=${gcalResult.documents} chunks=${gcalResult.chunks}`,
        );
      }
    } catch (err: any) {
      if (!(err instanceof QuotaExceededError)) throw err;
      planLimitHit = true;
      console.error(`[index-account] ${accountId} gcal FAILED: ${err?.message ?? err}`);
      await deps.recordRun({
        worker: "indexer",
        source: "gcal",
        ok: false,
        error: "plan_limit",
        startedAt: new Date(),
        endedAt: new Date(),
        accountId,
      });
    }
  } else {
    // plan gate closed — record a skipped run for each paid source so status_runs is never silent.
    await deps.recordRun({
      worker: "indexer",
      source: `granola-${FRIEND_WORKSPACE}`,
      ok: true,
      counts: { skipped: "plan_gate" },
      startedAt: new Date(),
      endedAt: new Date(),
      accountId,
    });
    await deps.recordRun({
      worker: "indexer",
      source: "calendar",
      ok: true,
      counts: { skipped: "plan_gate" },
      startedAt: new Date(),
      endedAt: new Date(),
      accountId,
    });
    await deps.recordRun({
      worker: "indexer",
      source: "gcal",
      ok: true,
      counts: { skipped: "plan_gate" },
      startedAt: new Date(),
      endedAt: new Date(),
      accountId,
    });
  }

  return { documents, chunks };
}
