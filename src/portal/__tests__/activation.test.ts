// src/portal/__tests__/activation.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);

import { getActivationState, markAsked, dismissActivation } from "../activation.js";
import { setTasksDbId } from "../task-tracker.js";
import { setGranolaKey, addIcalLink } from "../sources.js";
import { __setPoolForTest } from "../../rag/storage.js";

let store: Map<string, string>;
function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/DELETE FROM account_secrets/i.test(sql)) {
        store.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}
beforeEach(() => { store = new Map(); __setPoolForTest(memPool() as never); });
afterEach(() => __setPoolForTest(null));

test("conta nova: nada feito, não completa", async () => {
  const s = await getActivationState("friend:1");
  assert.deepEqual(s.items, { tasks: false, granola: false, ical: false, ask: false });
  assert.equal(s.complete, false);
  assert.equal(s.dismissed, false);
});

test("itens refletem fontes + tasks_db_id + ask; completa quando os 4 batem", async () => {
  await setTasksDbId("friend:1", "ds-1");
  await setGranolaKey("friend:1", "grn_key_zzzz");
  await addIcalLink("friend:1", { url: "https://x/y.ics", label: "Pessoal" });
  let s = await getActivationState("friend:1");
  assert.deepEqual(s.items, { tasks: true, granola: true, ical: true, ask: false });
  assert.equal(s.complete, false); // falta o ask

  await markAsked("friend:1");
  s = await getActivationState("friend:1");
  assert.equal(s.items.ask, true);
  assert.equal(s.complete, true);
});

test("dismiss esconde o checklist mesmo sem completar", async () => {
  await dismissActivation("friend:1");
  const s = await getActivationState("friend:1");
  assert.equal(s.dismissed, true);
  assert.equal(s.complete, true); // dismissed conta como concluído p/ esconder
});
