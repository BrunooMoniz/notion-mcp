// src/billing/__tests__/resync-cron.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dueAccounts, runResyncTick } from "../resync-cron.js";
import { __setPoolForTest } from "../../rag/storage.js";

interface Row { id: string; plan: string; last_run: Date | null }

function memPool(rows: Row[]) {
  return {
    query: async (sql: string) => {
      if (/FROM account a/i.test(sql)) {
        return { rows: rows.map((r) => ({ id: r.id, plan: r.plan, last_run: r.last_run })) };
      }
      return { rows: [] };
    },
  };
}

const NOW = new Date("2026-06-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

afterEach(() => __setPoolForTest(null));

test("dueAccounts: free skipped; paid due iff older than interval", async () => {
  __setPoolForTest(memPool([
    { id: "f:free", plan: "free", last_run: hoursAgo(999) },     // free -> never
    { id: "f:ess", plan: "essencial", last_run: hoursAgo(25) },  // 24h interval -> due
    { id: "f:ess2", plan: "essencial", last_run: hoursAgo(2) },  // not due
    { id: "f:pro", plan: "pro", last_run: null },                // never indexed -> due
    { id: "f:ili", plan: "ilimitado", last_run: hoursAgo(0.5) }, // 1h interval -> not due
  ]) as never);
  const due = await dueAccounts(NOW);
  assert.deepEqual(due.sort(), ["f:ess", "f:pro"]);
});

test("runResyncTick calls the injected indexer for each due account", async () => {
  __setPoolForTest(memPool([
    { id: "f:pro", plan: "pro", last_run: hoursAgo(7) }, // 6h interval -> due
  ]) as never);
  const called: string[] = [];
  const { ran } = await runResyncTick(NOW, async (id) => { called.push(id); });
  assert.deepEqual(called, ["f:pro"]);
  assert.deepEqual(ran, ["f:pro"]);
});
