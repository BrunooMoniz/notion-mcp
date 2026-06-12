// src/rag/__tests__/index-account-plan-limit.test.ts
// Bug #96 (3) — teto de chunks do plano durante a indexação. Antes, o
// QuotaExceededError de replaceDocumentChunks era gravado como erro genérico e
// as demais fontes seguiam estourando o mesmo limite uma a uma; o usuário não
// via nada além de "erro". Agora: a fonte que estourou grava status_run com
// error="plan_limit" (counts parciais), as fontes ainda não processadas gravam
// {skipped:"plan_limit"} sem rodar, e o run geral termina graceful.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  indexAccount,
  __setIndexAccountDepsForTest,
  type IndexAccountDeps,
} from "../index-account.js";
import { QuotaExceededError } from "../../billing/usage.js";
import type { IndexableDocument, ChunkWithEmbedding } from "../types.js";

function doc(source: string): IndexableDocument {
  return {
    source_type: source as "notion",
    source_id: `${source}:doc-1`,
    workspace: "personal",
    db_name: null,
    parent_url: null,
    text: "content",
    metadata: {},
    source_updated: new Date(),
  };
}

async function* oneDoc(source: string): AsyncIterable<IndexableDocument> {
  yield doc(source);
}

function makeChunk(d: IndexableDocument): ChunkWithEmbedding {
  return {
    id: d.source_id + ":0",
    source_type: d.source_type,
    source_id: d.source_id,
    workspace: d.workspace ?? "personal",
    db_name: null,
    parent_url: null,
    chunk_index: 0,
    text: d.text,
    embedding: [0.1],
    metadata: {},
    source_updated: null,
  };
}

type RunRecord = { source: string; ok: boolean; counts?: unknown; error?: string | null };

function makeDeps(opts: {
  workspaces: string[];
  quotaOn: (sourceType: string) => boolean;
  recordRuns: RunRecord[];
  granolaCalled: { flag: boolean };
  gcalCalled: { flag: boolean };
}): IndexAccountDeps {
  return {
    warmAccount: async () => opts.workspaces,
    accountHasFeature: async () => true, // plano pro: granola+calendar liberados
    getAccountSecret: async (_acc, kind) => (kind === "granola" ? "grn_key" : null),
    fetchWorkspaceDocuments: () => oneDoc("notion"),
    fetchGranolaDocuments: () => {
      opts.granolaCalled.flag = true;
      return oneDoc("granola");
    },
    fetchIcsCalendarDocuments: () => oneDoc("calendar"),
    indexDocument: async (d) => [makeChunk(d)],
    replaceDocumentChunks: async (sourceType) => {
      if (opts.quotaOn(sourceType)) {
        throw new QuotaExceededError("chunks indexados", 2000, 1999);
      }
    },
    deleteBySource: async () => {},
    setSyncState: async () => {},
    recordRun: async (run) => {
      opts.recordRuns.push({
        source: run.source,
        ok: run.ok,
        counts: run.counts,
        error: run.error ?? null,
      });
    },
    pruneOrphans: async () => 0,
    ensureAccountWorkspace: async () => {},
    indexGcalOAuthForAccount: async () => {
      opts.gcalCalled.flag = true;
      return { documents: 0, chunks: 0 };
    },
  };
}

afterEach(() => {
  __setIndexAccountDepsForTest(null);
});

test("quota de chunks no notion: run não explode, fonte grava plan_limit e as demais são puladas", async () => {
  const recordRuns: RunRecord[] = [];
  const granolaCalled = { flag: false };
  const gcalCalled = { flag: false };
  __setIndexAccountDepsForTest(
    makeDeps({
      workspaces: ["ws-1", "ws-2"],
      quotaOn: (st) => st === "notion",
      recordRuns,
      granolaCalled,
      gcalCalled,
    }),
  );

  // graceful: nunca lança
  const totals = await indexAccount("friend:limited");
  assert.deepEqual(totals, { documents: 0, chunks: 0 });

  // fonte que estourou: ok=false, error="plan_limit", counts parciais
  const ws1 = recordRuns.find((r) => r.source === "notion-ws-1");
  assert.ok(ws1, `notion-ws-1 deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
  assert.equal(ws1!.ok, false);
  assert.equal(ws1!.error, "plan_limit");
  assert.deepEqual(ws1!.counts, { documents: 0, chunks: 0 });

  // workspace seguinte não processado: skipped plan_limit, sem fetch
  const ws2 = recordRuns.find((r) => r.source === "notion-ws-2");
  assert.ok(ws2, `notion-ws-2 deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
  assert.equal((ws2!.counts as Record<string, string>).skipped, "plan_limit");

  // granola/calendar/gcal: pulados com plan_limit, sem rodar de fato
  for (const src of ["granola-personal", "calendar", "gcal"]) {
    const run = recordRuns.find((r) => r.source === src);
    assert.ok(run, `${src} deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
    assert.equal(
      (run!.counts as Record<string, string>).skipped,
      "plan_limit",
      `${src} deve ter skipped=plan_limit`,
    );
  }
  assert.equal(granolaCalled.flag, false, "granola não deve rodar após o limite");
  assert.equal(gcalCalled.flag, false, "gcal não deve rodar após o limite");
});

test("quota de chunks no granola: notion ok, granola plan_limit, calendar e gcal pulados", async () => {
  const recordRuns: RunRecord[] = [];
  const granolaCalled = { flag: false };
  const gcalCalled = { flag: false };
  __setIndexAccountDepsForTest(
    makeDeps({
      workspaces: ["ws-1"],
      quotaOn: (st) => st === "granola",
      recordRuns,
      granolaCalled,
      gcalCalled,
    }),
  );

  await indexAccount("friend:limited2");

  const notion = recordRuns.find((r) => r.source === "notion-ws-1");
  assert.ok(notion);
  assert.equal(notion!.ok, true);

  const granola = recordRuns.find((r) => r.source === "granola-personal");
  assert.ok(granola, `granola deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
  assert.equal(granola!.ok, false);
  assert.equal(granola!.error, "plan_limit");

  for (const src of ["calendar", "gcal"]) {
    const run = recordRuns.find((r) => r.source === src);
    assert.ok(run, `${src} deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
    assert.equal((run!.counts as Record<string, string>).skipped, "plan_limit");
  }
  assert.equal(gcalCalled.flag, false);
});

test("erro comum (não-quota) mantém o comportamento atual: erro original gravado e demais fontes rodam", async () => {
  const recordRuns: RunRecord[] = [];
  const granolaCalled = { flag: false };
  const gcalCalled = { flag: false };
  const deps = makeDeps({
    workspaces: ["ws-1"],
    quotaOn: () => false,
    recordRuns,
    granolaCalled,
    gcalCalled,
  });
  deps.fetchWorkspaceDocuments = () => {
    throw new Error("notion API down");
  };
  __setIndexAccountDepsForTest(deps);

  await indexAccount("friend:apierror");

  const notion = recordRuns.find((r) => r.source === "notion-ws-1");
  assert.ok(notion);
  assert.equal(notion!.ok, false);
  assert.equal(notion!.error, "notion API down");
  assert.ok(granolaCalled.flag, "granola deve rodar normalmente após erro não-quota");
  assert.ok(gcalCalled.flag, "gcal deve rodar normalmente após erro não-quota");
});
