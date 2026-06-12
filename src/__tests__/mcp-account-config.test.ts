// src/__tests__/mcp-account-config.test.ts
// Zinom-first — as instructions (owner e friend) precisam trazer a regra de
// preferir o Zinom para tarefas/calendário, o link do board (tracker_url) e a
// tool zinom_setup_tasks. OWNER_INSTRUCTIONS migrou de index.ts para o módulo
// puro mcp-account-config.ts justamente para ser testável sem boot do servidor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_INSTRUCTIONS, FRIEND_INSTRUCTIONS } from "../mcp-account-config.js";

test("owner e friend instructions trazem a regra Zinom-first e os links", () => {
  for (const s of [OWNER_INSTRUCTIONS, FRIEND_INSTRUCTIONS]) {
    assert.match(s, /Zinom primeiro para tarefas e calendário/);
    assert.match(s, /tracker_url/);
    assert.match(s, /zinom_setup_tasks/);
  }
});
