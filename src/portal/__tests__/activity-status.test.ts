// src/portal/__tests__/activity-status.test.ts
// E2.1 — unit tests for buildActivitySources() (pure function, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildActivitySources,
  type ActivityCredentials,
  type ActivitySource,
} from "../activity-status.js";
import type { StatusSource } from "../../rag/status.js";

// ---- helpers ----------------------------------------------------------------

const NOW = new Date("2026-06-09T12:00:00Z");
const ISO_NOW = NOW.toISOString();

function makeRun(source: string, overrides: Partial<StatusSource> = {}): StatusSource {
  return {
    worker: "indexer",
    source,
    ok: true,
    last_run_at: ISO_NOW,
    sync_last_at: null,
    age_seconds: 0,
    stale: false,
    counts: { documents: 5, chunks: 20 },
    error: null,
    ...overrides,
  };
}

const NO_CREDS: ActivityCredentials = {
  notionWorkspaces: [],
  hasGranola: false,
  icalLinks: [],
  googleAccounts: [],
};

// ---- empty credentials → empty list ----------------------------------------

test("no credentials → empty list", () => {
  const result = buildActivitySources(NO_CREDS, [], false);
  assert.deepEqual(result, []);
});

// ---- Notion -----------------------------------------------------------------

test("Notion workspace with no run → aguardando_primeira_indexacao", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-abc", name: "Meu Notion" }],
  };
  const [entry] = buildActivitySources(creds, [], false);
  assert.equal(entry.source, "notion-ws-abc");
  assert.equal(entry.source_type, "notion");
  assert.equal(entry.display_name, "Meu Notion");
  assert.equal(entry.estado, "aguardando_primeira_indexacao");
  assert.equal(entry.counts, null);
  assert.equal(entry.last_run, null);
  assert.equal(entry.error, null);
});

test("Notion workspace with a successful run → ok, display_name from name", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-abc", name: "Caderno" }],
  };
  const runs = [makeRun("notion-ws-abc")];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "ok");
  assert.equal(entry.display_name, "Caderno");
  assert.deepEqual(entry.counts, { documents: 5, chunks: 20 });
  assert.equal(entry.last_run, ISO_NOW);
  assert.equal(entry.error, null);
});

test("Notion workspace with null name → falls back to workspace id", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-xyz", name: null }],
  };
  const [entry] = buildActivitySources(creds, [], false);
  assert.equal(entry.display_name, "ws-xyz");
});

test("Notion workspace with a failed run → erro, error truncated", () => {
  const longErr = "A".repeat(300);
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-abc", name: "W" }],
  };
  const runs = [makeRun("notion-ws-abc", { ok: false, error: longErr })];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "erro");
  assert.ok(entry.error !== null && entry.error.length <= 201); // 200 + "…"
  assert.ok(entry.error!.endsWith("…"));
});

test("workspace sintético (sem credencial Notion) não vira fonte Notion", () => {
  // Bug #96 (1): quando um friend conecta Granola/iCal, ensureAccountWorkspace
  // registra o workspace "personal" em account_workspaces SEM credencial Notion.
  // Esse workspace sintético não pode aparecer como fonte Notion fantasma.
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [
      { workspace: "ws-real", name: "Caderno", hasCredential: true },
      { workspace: "personal", name: null, hasCredential: false },
    ],
    hasGranola: true,
  };
  const result = buildActivitySources(creds, [], false);
  const notion = result.filter((e) => e.source_type === "notion");
  assert.equal(notion.length, 1);
  assert.equal(notion[0].source, "notion-ws-real");
  // Granola continua com a própria entrada
  assert.equal(result.filter((e) => e.source_type === "granola").length, 1);
});

test("workspace sem o campo hasCredential continua aparecendo (compat)", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-legacy", name: "Legacy" }],
  };
  const result = buildActivitySources(creds, [], false);
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "notion-ws-legacy");
});

test("multiple Notion workspaces → one entry each", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [
      { workspace: "ws-a", name: "Alpha" },
      { workspace: "ws-b", name: "Beta" },
    ],
  };
  const runs = [makeRun("notion-ws-a"), makeRun("notion-ws-b", { counts: { documents: 2, chunks: 4 } })];
  const result = buildActivitySources(creds, runs, false);
  assert.equal(result.length, 2);
  assert.equal(result[0].display_name, "Alpha");
  assert.equal(result[1].display_name, "Beta");
  assert.equal(result[1].estado, "ok");
});

// ---- running flag -----------------------------------------------------------

test("running=true → estado is indexando for all sources with runs", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-abc", name: "W" }],
    hasGranola: true,
  };
  const runs = [makeRun("notion-ws-abc"), makeRun("granola-friend")];
  const result = buildActivitySources(creds, runs, true);
  for (const e of result) {
    assert.equal(e.estado, "indexando");
  }
});

test("running=true with no run → still indexando", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-abc", name: "W" }],
  };
  const [entry] = buildActivitySources(creds, [], true);
  assert.equal(entry.estado, "indexando");
});

test("running=true + runningSince: source finished INSIDE this run shows ok", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [
      { workspace: "ws-done", name: "Done" },
      { workspace: "ws-pending", name: "Pending" },
    ],
  };
  const runningSince = new Date("2026-06-09T11:00:00Z");
  const runs = [
    // finished after the reindex started → real result surfaces
    makeRun("notion-ws-done", { last_run_at: "2026-06-09T11:30:00Z" }),
    // last run predates this reindex → still being processed
    makeRun("notion-ws-pending", { last_run_at: "2026-06-09T09:00:00Z" }),
  ];
  const [done, pending] = buildActivitySources(creds, runs, true, { runningSince });
  assert.equal(done.estado, "ok");
  assert.equal(pending.estado, "indexando");
});

test("running=true + runningSince: source that FAILED inside this run shows erro", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-a", name: "W" }],
  };
  const runningSince = new Date("2026-06-09T11:00:00Z");
  const runs = [makeRun("notion-ws-a", { ok: false, error: "boom", last_run_at: "2026-06-09T11:30:00Z" })];
  const [entry] = buildActivitySources(creds, runs, true, { runningSince });
  assert.equal(entry.estado, "erro");
  assert.equal(entry.error, "boom");
});

test("live counts attach per source key; missing key → null", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [
      { workspace: "ws-a", name: "Alpha" },
      { workspace: "ws-b", name: "Beta" },
    ],
    hasGranola: true,
    icalLinks: [{ id: "c1", label: "Cal" }],
  };
  const liveCounts = new Map([
    ["notion-ws-a", { documents: 100, chunks: 400 }],
    ["notion-ws-b", { documents: 7, chunks: 21 }],
    ["granola", { documents: 3, chunks: 9 }],
  ]);
  const [a, b, g, cal] = buildActivitySources(creds, [], false, { liveCounts });
  assert.equal(a.documents, 100);
  assert.equal(b.documents, 7);
  assert.equal(b.chunks, 21);
  assert.equal(g.documents, 3);
  assert.equal(cal.documents, null);
});

// ---- Granola ----------------------------------------------------------------

test("hasGranola=false → no granola entry", () => {
  const result = buildActivitySources(NO_CREDS, [], false);
  assert.equal(result.filter((e) => e.source_type === "granola").length, 0);
});

test("hasGranola=true with no run → aguardando_primeira_indexacao", () => {
  const creds: ActivityCredentials = { ...NO_CREDS, hasGranola: true };
  const [entry] = buildActivitySources(creds, [], false);
  assert.equal(entry.source_type, "granola");
  assert.equal(entry.estado, "aguardando_primeira_indexacao");
  assert.equal(entry.display_name, "Granola");
});

test("hasGranola=true with skipped=no_credentials run → pulado_sem_credencial", () => {
  const creds: ActivityCredentials = { ...NO_CREDS, hasGranola: true };
  const runs = [makeRun("granola-friend", { counts: { skipped: "no_credentials" } })];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "pulado_sem_credencial");
});

test("hasGranola=true with skipped=plan_gate run → indisponivel_no_plano", () => {
  const creds: ActivityCredentials = { ...NO_CREDS, hasGranola: true };
  const runs = [makeRun("granola-friend", { counts: { skipped: "plan_gate" } })];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "indisponivel_no_plano");
});

test("hasGranola=true with successful run → ok, display_name=Granola", () => {
  const creds: ActivityCredentials = { ...NO_CREDS, hasGranola: true };
  const runs = [makeRun("granola-friend")];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "ok");
  assert.equal(entry.display_name, "Granola");
  assert.deepEqual(entry.counts, { documents: 5, chunks: 20 });
});

// ---- iCal ------------------------------------------------------------------

test("no ical links → no calendar entry", () => {
  const result = buildActivitySources(NO_CREDS, [], false);
  assert.equal(result.filter((e) => e.source_type === "calendar").length, 0);
});

test("one ical link with no run → aguardando_primeira_indexacao, label from link", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    icalLinks: [{ id: "a1", label: "Agenda Pessoal" }],
  };
  const [entry] = buildActivitySources(creds, [], false);
  assert.equal(entry.source_type, "calendar");
  assert.equal(entry.display_name, "Agenda Pessoal");
  assert.equal(entry.estado, "aguardando_primeira_indexacao");
});

test("one ical link with blank label → default display_name", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    icalLinks: [{ id: "a1", label: "" }],
  };
  const [entry] = buildActivitySources(creds, [], false);
  assert.equal(entry.display_name, "Calendário iCal");
});

test("multiple ical links → single entry with count in name", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    icalLinks: [
      { id: "a1", label: "Pessoal" },
      { id: "a2", label: "Trabalho" },
    ],
  };
  const result = buildActivitySources(creds, [], false);
  const calEntries = result.filter((e) => e.source_type === "calendar");
  assert.equal(calEntries.length, 1);
  assert.match(calEntries[0].display_name, /Calendários iCal \(2\)/);
});

test("ical link with successful calendar run → ok", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    icalLinks: [{ id: "a1", label: "Cal" }],
  };
  const runs = [makeRun("calendar")];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "ok");
});

// ---- Google Calendar OAuth -------------------------------------------------

test("no google accounts → no gcal entry", () => {
  const result = buildActivitySources(NO_CREDS, [], false);
  assert.equal(result.filter((e) => e.source_type === "gcal").length, 0);
});

test("one google account with no run → aguardando_primeira_indexacao, email as name", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    googleAccounts: [{ email: "user@gmail.com" }],
  };
  const [entry] = buildActivitySources(creds, [], false);
  assert.equal(entry.source_type, "gcal");
  assert.equal(entry.display_name, "user@gmail.com");
  assert.equal(entry.estado, "aguardando_primeira_indexacao");
});

test("two google accounts → one gcal entry per account (shared run key)", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    googleAccounts: [{ email: "a@gmail.com" }, { email: "b@gmail.com" }],
  };
  const result = buildActivitySources(creds, [], false);
  const gcal = result.filter((e) => e.source_type === "gcal");
  assert.equal(gcal.length, 2);
  assert.equal(gcal[0].display_name, "a@gmail.com");
  assert.equal(gcal[0].source, "gcal:a@gmail.com");
  assert.equal(gcal[1].display_name, "b@gmail.com");
  assert.equal(gcal[1].source, "gcal:b@gmail.com");
});

test("gcal entries get per-account live counts via gcal:<email> keys", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    googleAccounts: [{ email: "a@gmail.com" }, { email: "b@gmail.com" }],
  };
  const liveCounts = new Map([
    ["gcal:a@gmail.com", { documents: 12, chunks: 30 }],
  ]);
  const [a, b] = buildActivitySources(creds, [makeRun("gcal")], false, { liveCounts });
  assert.equal(a.documents, 12);
  assert.equal(a.chunks, 30);
  // account with no indexed events yet → null (frontend shows 0)
  assert.equal(b.documents, null);
  assert.equal(b.chunks, null);
});

test("google account with successful gcal run → ok", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    googleAccounts: [{ email: "u@g.com" }],
  };
  const runs = [makeRun("gcal")];
  const [entry] = buildActivitySources(creds, runs, false);
  assert.equal(entry.estado, "ok");
});

// ---- mixed scenario ---------------------------------------------------------

test("all four source types present → four entries in correct order", () => {
  const creds: ActivityCredentials = {
    notionWorkspaces: [{ workspace: "ws-a", name: "Workspace A" }],
    hasGranola: true,
    icalLinks: [{ id: "c1", label: "Meu Cal" }],
    googleAccounts: [{ email: "me@gmail.com" }],
  };
  const result = buildActivitySources(creds, [], false);
  assert.equal(result.length, 4);
  assert.equal(result[0].source_type, "notion");
  assert.equal(result[1].source_type, "granola");
  assert.equal(result[2].source_type, "calendar");
  assert.equal(result[3].source_type, "gcal");
});

test("error field is null when estado is ok (no leak)", () => {
  const creds: ActivityCredentials = {
    ...NO_CREDS,
    notionWorkspaces: [{ workspace: "ws-a", name: "W" }],
  };
  const runs = [makeRun("notion-ws-a", { ok: true, error: "stale error from old run" })];
  const [entry] = buildActivitySources(creds, runs, false);
  // estado is ok, so error must not be surfaced
  assert.equal(entry.estado, "ok");
  assert.equal(entry.error, null);
});
