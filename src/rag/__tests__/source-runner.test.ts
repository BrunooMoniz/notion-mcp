// src/rag/__tests__/source-runner.test.ts
// F2.2: runSourcePass lifecycle, driven entirely with fakes. Runs WITHOUT any
// DB or API key — every dep (indexDocument + storage fns) is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSourcePass, type SourcePassDeps } from "../sources/runner.js";
import type {
  ChunkWithEmbedding,
  IndexableDocument,
  Source,
  SourcePassOptions,
} from "../types.js";

function fakeDoc(id: string): IndexableDocument {
  return {
    source_type: "web",
    source_id: id,
    workspace: "personal",
    db_name: null,
    parent_url: `https://example.com/${id}`,
    text: `body of ${id}`,
    metadata: { title: id },
    source_updated: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function fakeChunk(id: string, idx: number): ChunkWithEmbedding {
  return {
    id: `${id}-${idx}`,
    source_type: "web",
    source_id: id,
    workspace: "personal",
    db_name: null,
    parent_url: `https://example.com/${id}`,
    chunk_index: idx,
    text: `chunk ${idx} of ${id}`,
    embedding: [0.1, 0.2],
    metadata: { title: id },
    source_updated: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function makeSource(
  docs: IndexableDocument[],
  listImpl?: (opts: SourcePassOptions) => AsyncIterable<IndexableDocument>,
): Source {
  return {
    name: "web",
    sourceType: "web",
    isConfigured: () => true,
    listDocuments:
      listImpl ??
      (async function* () {
        for (const d of docs) yield d;
      }),
  };
}

test("runSourcePass indexes each doc, replaces, upserts, advances sync, records ok", async () => {
  const source = makeSource([fakeDoc("a"), fakeDoc("b")]);

  const deleteCalls: Array<[string, string]> = [];
  const upserted: ChunkWithEmbedding[][] = [];
  const setSyncCalls: Array<[string, Date]> = [];
  const recorded: any[] = [];

  const deps: Partial<SourcePassDeps> = {
    // 2 chunks per doc
    indexDocument: async (doc) => [fakeChunk(doc.source_id, 0), fakeChunk(doc.source_id, 1)],
    deleteBySource: async (st, id) => {
      deleteCalls.push([st, id]);
    },
    upsertChunks: async (chunks) => {
      upserted.push(chunks);
    },
    getSyncState: async () => new Date(0),
    setSyncState: async (key, ts) => {
      setSyncCalls.push([key, ts]);
    },
    recordRun: async (r) => {
      recorded.push(r);
    },
  };

  const result = await runSourcePass(source, { fullReindex: false }, deps);

  assert.deepEqual(result, { documents: 2, chunks: 4 });

  // deleteBySource ran once per doc, scoped to the source's bare type "web".
  assert.deepEqual(deleteCalls, [
    ["web", "a"],
    ["web", "b"],
  ]);

  // upsert got ALL chunks in one call.
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].length, 4);

  // sync state advanced under the source key.
  assert.equal(setSyncCalls.length, 1);
  assert.equal(setSyncCalls[0][0], "web");
  assert.ok(setSyncCalls[0][1] instanceof Date);

  // recordRun(ok:true) with the worker/source/counts shape.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].ok, true);
  assert.equal(recorded[0].worker, "indexer");
  assert.equal(recorded[0].source, "web");
  assert.deepEqual(recorded[0].counts, { documents: 2, chunks: 4 });
});

test("runSourcePass uses epoch lastSync on fullReindex (does not call getSyncState)", async () => {
  let getSyncCalled = false;
  let seenModifiedSince: Date | undefined;
  const source = makeSource([], async function* (opts) {
    seenModifiedSince = opts.modifiedSince;
    // yield nothing
  });
  await runSourcePass(
    source,
    { fullReindex: true },
    {
      indexDocument: async () => [],
      deleteBySource: async () => {},
      upsertChunks: async () => {},
      getSyncState: async () => {
        getSyncCalled = true;
        return new Date("2030-01-01");
      },
      setSyncState: async () => {},
      recordRun: async () => {},
    },
  );
  assert.equal(getSyncCalled, false);
  assert.equal(seenModifiedSince?.getTime(), 0);
});

test("runSourcePass records ok:false and does NOT throw when listDocuments throws", async () => {
  const source = makeSource([], async function* () {
    throw new Error("feed exploded");
  });

  const recorded: any[] = [];
  let upsertCalled = false;

  const result = await runSourcePass(
    source,
    { fullReindex: false },
    {
      indexDocument: async () => [],
      deleteBySource: async () => {},
      upsertChunks: async () => {
        upsertCalled = true;
      },
      getSyncState: async () => new Date(0),
      setSyncState: async () => {},
      recordRun: async (r) => {
        recorded.push(r);
      },
    },
  );

  // It swallowed the throw and returned partial counts.
  assert.deepEqual(result, { documents: 0, chunks: 0 });
  assert.equal(upsertCalled, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].ok, false);
  assert.equal(recorded[0].source, "web");
  assert.match(recorded[0].error, /feed exploded/);
});
