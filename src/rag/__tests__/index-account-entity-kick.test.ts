// Grafo para todos os usuários: indexAccount (onboarding e /reindex) dispara a
// extração de entidades da própria conta ao final, sem esperar o cron do
// classifier. Padrão de DI dos testes de index-account.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  indexAccount,
  __setIndexAccountDepsForTest,
  type IndexAccountDeps,
} from "../index-account.js";

afterEach(() => __setIndexAccountDepsForTest(null));

function makeDeps(kicked: string[]): IndexAccountDeps {
  return {
    warmAccount: async () => [],
    accountHasFeature: async () => false,
    getAccountSecret: async () => null,
    fetchWorkspaceDocuments: () => (async function* () {})(),
    fetchGranolaDocuments: () => (async function* () {})(),
    fetchIcsCalendarDocuments: () => (async function* () {})(),
    indexDocument: async () => [],
    replaceDocumentChunks: async () => {},
    deleteBySource: async () => {},
    setSyncState: async () => {},
    recordRun: async () => {},
    pruneOrphans: async () => 0,
    ensureAccountWorkspace: async () => {},
    indexGcalOAuthForAccount: async () => ({ documents: 0, chunks: 0 }),
    kickEntityExtraction: (accountId) => {
      kicked.push(accountId);
    },
  };
}

test("indexAccount dispara a extração de entidades da conta ao final", async () => {
  const kicked: string[] = [];
  __setIndexAccountDepsForTest(makeDeps(kicked));

  const result = await indexAccount("friend:nova");

  assert.deepEqual(kicked, ["friend:nova"]);
  assert.deepEqual(result, { documents: 0, chunks: 0 });
});

test("indexAccount dispara o kick uma única vez por run", async () => {
  const kicked: string[] = [];
  __setIndexAccountDepsForTest(makeDeps(kicked));

  await indexAccount("friend:a");
  await indexAccount("friend:b");

  assert.deepEqual(kicked, ["friend:a", "friend:b"]);
});
