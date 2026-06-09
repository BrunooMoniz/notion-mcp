import { test } from "node:test";
import assert from "node:assert";
import { notify, __setFetchForTest } from "../notify.js";

test("notify posts to ntfy topic with title and priority", async () => {
  process.env.NTFY_URL = "http://127.0.0.1:8091/zinom-alerts";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  __setFetchForTest(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response("ok");
  });
  await notify("indexer falhou: granola", { title: "Zinom alerta", priority: "high" });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /\/zinom-alerts$/);
  assert.strictEqual(calls[0].init.body, "indexer falhou: granola");
  assert.strictEqual((calls[0].init.headers as Record<string, string>).Title, "Zinom alerta");
});

test("notify is a no-op when NTFY_URL unset", async () => {
  delete process.env.NTFY_URL;
  __setFetchForTest(async () => { throw new Error("não deveria chamar fetch"); });
  await notify("mensagem"); // não deve lançar
});
