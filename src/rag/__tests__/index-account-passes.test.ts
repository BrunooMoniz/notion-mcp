// src/rag/__tests__/index-account-passes.test.ts
// Reproducer + regression for P0: indexAccount() silently skipping Granola and
// Google Calendar passes for friend accounts, leaving status_runs empty for
// those sources. With the dep-injection seam this test can run fully in-process
// without a live DB, Notion API, Voyage, or Granola API.
//
// Three scenarios:
//  1. plan=free  → plan gate fires; all three paid sources emit recordRun
//                  {skipped:"plan_gate"}. This was silent before the fix.
//  2. plan=pro, granola key absent → granola emits recordRun {skipped:"no_credentials"}.
//     ical absent → calendar emits {skipped:"no_credentials"}.
//     gcal runs normally (no accounts → indexGcalOAuthForAccount returns 0 docs).
//  3. plan=pro, all 4 secrets present → notion + granola + gcal all invoked; all
//     recordRun calls recorded.
import { test, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import {
  indexAccount,
  __setIndexAccountDepsForTest,
  type IndexAccountDeps,
} from "../index-account.js";
import type { IndexableDocument, ChunkWithEmbedding } from "../types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function emptyDoc(source: string): IndexableDocument {
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

async function* noDoc(): AsyncIterable<IndexableDocument> {
  // yields nothing — simulates an empty workspace/granola account
}

async function* oneDoc(source: string): AsyncIterable<IndexableDocument> {
  yield emptyDoc(source);
}

function makeChunk(doc: IndexableDocument): ChunkWithEmbedding {
  return {
    id: doc.source_id + ":0",
    source_type: doc.source_type,
    source_id: doc.source_id,
    workspace: doc.workspace ?? "personal",
    db_name: null,
    parent_url: null,
    chunk_index: 0,
    text: doc.text,
    embedding: [0.1],
    metadata: {},
    source_updated: null,
  };
}

type RunRecord = { source: string; ok: boolean; counts?: unknown };

/** Build a minimal IndexAccountDeps with specified plan and secrets. */
function makeDeps(opts: {
  plan: string;
  granolaKey: string | null;
  icalKey: string | null;
  googleAccounts: number; // how many google accounts to simulate
  recordRuns: RunRecord[];
  notionCalled: { flag: boolean };
  granolaCalled: { flag: boolean };
  gcalCalled: { flag: boolean };
}): IndexAccountDeps {
  const {
    plan,
    granolaKey,
    icalKey,
    googleAccounts,
    recordRuns,
    notionCalled,
    granolaCalled,
    gcalCalled,
  } = opts;

  return {
    warmAccount: async (_accountId) => ["ws-test"],

    accountHasFeature: async (_accountId, feature) => {
      if (feature === "granolaCalendar") {
        return plan === "pro" || plan === "essencial" || plan === "ilimitado" || plan === "owner";
      }
      return false;
    },

    getAccountSecret: async (_accountId, kind) => {
      if (kind === "granola") return granolaKey;
      if (kind === "ical") return icalKey;
      return null;
    },

    fetchWorkspaceDocuments: (_opts) => {
      notionCalled.flag = true;
      return oneDoc("notion");
    },

    fetchGranolaDocuments: (_opts) => {
      granolaCalled.flag = true;
      return oneDoc("granola");
    },

    fetchIcsCalendarDocuments: (_opts) => noDoc(),

    indexDocument: async (doc) => [makeChunk(doc)],

    replaceDocumentChunks: async () => {},

    deleteBySource: async () => {},

    setSyncState: async () => {},

    recordRun: async (run) => {
      recordRuns.push({ source: run.source, ok: run.ok, counts: run.counts });
    },

    pruneOrphans: async () => 0,

    ensureAccountWorkspace: async () => {},

    indexGcalOAuthForAccount: async (_accountId, _workspace) => {
      gcalCalled.flag = true;
      // Simulate: N google accounts linked but no events returned.
      // The real indexGcalOAuthForAccount records its own runs internally;
      // we just return totals here.
      return { documents: googleAccounts, chunks: googleAccounts };
    },
  };
}

afterEach(() => {
  __setIndexAccountDepsForTest(null);
});

// ─── Scenario 1: plan=free silently skipped ALL paid passes before fix ───────

describe("plan=free (plan gate)", () => {
  test("each skipped paid source records a run with skipped:plan_gate", async () => {
    const recordRuns: RunRecord[] = [];
    const notionCalled = { flag: false };
    const granolaCalled = { flag: false };
    const gcalCalled = { flag: false };

    __setIndexAccountDepsForTest(
      makeDeps({
        plan: "free",
        granolaKey: "grn_fake",
        icalKey: null,
        googleAccounts: 1,
        recordRuns,
        notionCalled,
        granolaCalled,
        gcalCalled,
      }),
    );

    await indexAccount("friend:test-free");

    // Notion runs even for free plan
    assert.ok(notionCalled.flag, "Notion pass deve rodar para plan=free");

    // Paid passes must NOT actively run (no actual fetch)
    assert.equal(granolaCalled.flag, false, "Granola fetch NÃO deve rodar para plan=free");
    assert.equal(gcalCalled.flag, false, "GCal fetch NÃO deve rodar para plan=free");

    // But they MUST record a skipped run — THIS IS THE BUG THAT WAS MISSING
    const granolaRun = recordRuns.find((r) => r.source.startsWith("granola"));
    assert.ok(
      granolaRun !== undefined,
      `Granola deve ter um recordRun quando plan=free. Runs: ${JSON.stringify(recordRuns)}`,
    );
    assert.deepEqual(
      (granolaRun!.counts as Record<string, string>).skipped,
      "plan_gate",
      "granola run deve ter skipped=plan_gate",
    );

    const gcalRun = recordRuns.find((r) => r.source === "gcal");
    assert.ok(
      gcalRun !== undefined,
      `GCal deve ter um recordRun quando plan=free. Runs: ${JSON.stringify(recordRuns)}`,
    );
    assert.deepEqual(
      (gcalRun!.counts as Record<string, string>).skipped,
      "plan_gate",
      "gcal run deve ter skipped=plan_gate",
    );

    const calendarRun = recordRuns.find((r) => r.source === "calendar");
    assert.ok(
      calendarRun !== undefined,
      `Calendar deve ter um recordRun quando plan=free. Runs: ${JSON.stringify(recordRuns)}`,
    );
    assert.deepEqual(
      (calendarRun!.counts as Record<string, string>).skipped,
      "plan_gate",
      "calendar run deve ter skipped=plan_gate",
    );
  });
});

// ─── Scenario 2: plan=pro, credentials absent ────────────────────────────────

describe("plan=pro, sem credenciais de Granola/iCal", () => {
  test("granola sem chave emite recordRun com skipped:no_credentials", async () => {
    const recordRuns: RunRecord[] = [];
    const granolaCalled = { flag: false };
    const gcalCalled = { flag: false };

    __setIndexAccountDepsForTest(
      makeDeps({
        plan: "pro",
        granolaKey: null, // sem chave
        icalKey: null,
        googleAccounts: 0,
        recordRuns,
        notionCalled: { flag: false },
        granolaCalled,
        gcalCalled,
      }),
    );

    await indexAccount("friend:test-pro-no-creds");

    // Granola fetch não deve ter sido chamado
    assert.equal(granolaCalled.flag, false, "Granola fetch NÃO deve rodar sem chave");

    // Deve ter registrado run com skipped:no_credentials
    const granolaRun = recordRuns.find((r) => r.source.startsWith("granola"));
    assert.ok(
      granolaRun !== undefined,
      `Granola deve ter um recordRun mesmo sem credencial. Runs: ${JSON.stringify(recordRuns)}`,
    );
    assert.deepEqual(
      (granolaRun!.counts as Record<string, string>).skipped,
      "no_credentials",
      "granola run deve ter skipped=no_credentials",
    );
  });
});

// ─── Scenario 3: plan=pro, todos os 4 secrets presentes ──────────────────────

describe("plan=pro, todos os secrets presentes (happy path)", () => {
  test("notion + granola + gcal são todos invocados e gravam runs", async () => {
    const recordRuns: RunRecord[] = [];
    const notionCalled = { flag: false };
    const granolaCalled = { flag: false };
    const gcalCalled = { flag: false };

    __setIndexAccountDepsForTest(
      makeDeps({
        plan: "pro",
        granolaKey: "grn_fake_key_pro",
        icalKey: null, // sem ical, mas com granola e google
        googleAccounts: 1,
        recordRuns,
        notionCalled,
        granolaCalled,
        gcalCalled,
      }),
    );

    const result = await indexAccount("friend:test-pro-full");

    // Todos os passes devem ter rodado
    assert.ok(notionCalled.flag, "Notion pass deve rodar");
    assert.ok(granolaCalled.flag, "Granola pass deve rodar com chave presente");
    assert.ok(gcalCalled.flag, "GCal pass deve rodar");

    // Notion run registrado
    const notionRun = recordRuns.find((r) => r.source.startsWith("notion-"));
    assert.ok(notionRun !== undefined, `Notion deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
    assert.equal(notionRun!.ok, true, "Notion run deve ser ok=true");

    // Granola run registrado
    const granolaRun = recordRuns.find((r) => r.source.startsWith("granola-"));
    assert.ok(granolaRun !== undefined, `Granola deve ter recordRun. Runs: ${JSON.stringify(recordRuns)}`);
    assert.equal(granolaRun!.ok, true, "Granola run deve ser ok=true");

    // Resultado positivo
    assert.ok(result.documents >= 2, `Deve ter indexado ao menos 2 documentos (notion + granola). Got: ${result.documents}`);
  });

  test("conta pro com todos os 4 secrets: notion_pat + google_oauth + granola + tasks_db", async () => {
    // Reproduz exatamente o cenário da conta friend:023096e0d292378f5c40eb90
    const recordRuns: RunRecord[] = [];
    const notionCalled = { flag: false };
    const granolaCalled = { flag: false };
    const gcalCalled = { flag: false };

    __setIndexAccountDepsForTest(
      makeDeps({
        plan: "pro",
        granolaKey: "grn_production_key", // simula o secret "granola" presente
        icalKey: null,                      // sem ical no cenário de produção
        googleAccounts: 1,                  // simula o secret "google_oauth" presente
        recordRuns,
        notionCalled,
        granolaCalled,
        gcalCalled,
      }),
    );

    await indexAccount("friend:023096e0d292378f5c40eb90");

    // O PONTO CENTRAL DO BUG: granola E gcal devem ter rodado.
    // Antes do fix, canGranolaCalendar era avaliado incorretamente para
    // contas friend com plan=free (default), e os passes eram silenciosamente
    // pulados sem nenhum recordRun.
    assert.ok(
      granolaCalled.flag,
      "Granola DEVE ser invocado para conta pro com secret granola presente",
    );
    assert.ok(
      gcalCalled.flag,
      "GCal DEVE ser invocado para conta pro com secret google_oauth presente",
    );

    const granolaRun = recordRuns.find((r) => r.source.startsWith("granola-"));
    assert.ok(
      granolaRun !== undefined,
      `Granola DEVE ter recordRun. status_runs estava vazio antes do fix. Runs: ${JSON.stringify(recordRuns)}`,
    );
    assert.equal(granolaRun!.ok, true);
  });
});
