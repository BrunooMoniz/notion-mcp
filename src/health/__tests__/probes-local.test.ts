// src/health/__tests__/probes-local.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { evalVps, parsePm2Jlist, pm2Probe } from "../probes-local.js";
import type { VpsNumbers } from "../probes-local.js";

// ---------------------------------------------------------------------------
// evalVps
// ---------------------------------------------------------------------------

test("evalVps: tudo dentro dos limites → ok", () => {
  const n: VpsNumbers = {
    load1: 1,
    cores: 4,
    memPct: 70,
    diskPct: 60,
    uptimeSec: 86400,
  };
  const r = evalVps(n);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.checkId, "vps");
  assert.strictEqual(r.group, "vps");
  assert.strictEqual(r.label, "VPS");
  assert.strictEqual(r.detail?.diskPct, 60);
  assert.strictEqual(r.detail?.memPct, 70);
});

test("evalVps: disco exatamente 80 → ok (limiar estrito >)", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 50, diskPct: 80, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "ok");
});

test("evalVps: disco 80.1 → warn", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 50, diskPct: 80.1, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "warn");
});

test("evalVps: disco 92 → warn (limiar fail estrito >92)", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 50, diskPct: 92, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "warn");
});

test("evalVps: disco 92.1 → fail", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 50, diskPct: 92.1, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "fail");
});

test("evalVps: mem exatamente 85 → ok", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 85, diskPct: 50, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "ok");
});

test("evalVps: mem 85.1 → warn", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 85.1, diskPct: 50, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "warn");
});

test("evalVps: mem 95.1 → fail", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 95.1, diskPct: 50, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "fail");
});

test("evalVps: load1 exatamente igual a cores → ok (limiar estrito >)", () => {
  const n: VpsNumbers = { load1: 4, cores: 4, memPct: 50, diskPct: 50, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "ok");
});

test("evalVps: load1 > cores → warn", () => {
  const n: VpsNumbers = { load1: 4.1, cores: 4, memPct: 50, diskPct: 50, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "warn");
});

test("evalVps: fail tem precedência sobre warn (disco fail + mem warn)", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 86, diskPct: 93, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "fail");
});

test("evalVps: diskPct null → ignora disco, avalia só mem/load", () => {
  // mem warn, disk ignorado
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 86, diskPct: null, uptimeSec: 0 };
  const r = evalVps(n);
  assert.strictEqual(r.status, "warn");
  assert.strictEqual(r.detail?.diskPct, null);
});

test("evalVps: diskPct null, tudo ok → ok (não vira fail por disk ignorado)", () => {
  const n: VpsNumbers = { load1: 0, cores: 4, memPct: 50, diskPct: null, uptimeSec: 0 };
  assert.strictEqual(evalVps(n).status, "ok");
});

test("evalVps: detail contém load1, load5, load15, cores, memPct, diskPct, uptimeSec", () => {
  const n: VpsNumbers = { load1: 1.5, cores: 4, memPct: 60, diskPct: 55, uptimeSec: 3600 };
  const r = evalVps(n);
  const d = r.detail as Record<string, unknown>;
  assert.ok("load1" in d);
  assert.ok("load5" in d);
  assert.ok("load15" in d);
  assert.ok("cores" in d);
  assert.ok("memPct" in d);
  assert.ok("diskPct" in d);
  assert.ok("uptimeSec" in d);
});

// ---------------------------------------------------------------------------
// parsePm2Jlist
// ---------------------------------------------------------------------------

function makePm2Item(
  name: string,
  status: string,
  restarts = 0,
  memBytes = 50 * 1024 * 1024,
) {
  return {
    name,
    pm2_env: { status, restart_time: restarts },
    monit: { memory: memBytes },
  };
}

const DEFAULT_EXPECTED = [
  "notion-mcp",
  "brain-indexer",
  "brain-classifier",
  "brain-reindex-nightly",
];

test("parsePm2Jlist: todos online → ok", () => {
  const items = [
    makePm2Item("notion-mcp", "online"),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-classifier", "online"),
    makePm2Item("brain-reindex-nightly", "stopped"),
  ];
  const r = parsePm2Jlist(JSON.stringify(items), DEFAULT_EXPECTED);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.checkId, "pm2");
  assert.strictEqual(r.group, "processos");
  assert.strictEqual(r.label, "Processos PM2");
});

test("parsePm2Jlist: brain-reindex-nightly stopped é normal → ok", () => {
  const items = [
    makePm2Item("notion-mcp", "online"),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-classifier", "online"),
    makePm2Item("brain-reindex-nightly", "stopped"),
  ];
  const r = parsePm2Jlist(JSON.stringify(items), DEFAULT_EXPECTED);
  assert.strictEqual(r.status, "ok");
  const detail = r.detail as Record<string, unknown>;
  const cron = detail["brain-reindex-nightly"] as Record<string, unknown>;
  assert.strictEqual(cron.status, "stopped");
});

test("parsePm2Jlist: processo esperado com status errored → fail", () => {
  const items = [
    makePm2Item("notion-mcp", "errored"),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-classifier", "online"),
    makePm2Item("brain-reindex-nightly", "stopped"),
  ];
  const r = parsePm2Jlist(JSON.stringify(items), DEFAULT_EXPECTED);
  assert.strictEqual(r.status, "fail");
});

test("parsePm2Jlist: processo esperado ausente → fail", () => {
  // falta brain-classifier
  const items = [
    makePm2Item("notion-mcp", "online"),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-reindex-nightly", "stopped"),
  ];
  const r = parsePm2Jlist(JSON.stringify(items), DEFAULT_EXPECTED);
  assert.strictEqual(r.status, "fail");
  assert.ok(r.error?.includes("brain-classifier"));
});

test("parsePm2Jlist: JSON inválido → fail com erro truncado (max 200 chars)", () => {
  const r = parsePm2Jlist("not-json", DEFAULT_EXPECTED);
  assert.strictEqual(r.status, "fail");
  assert.ok(typeof r.error === "string");
  assert.ok(r.error.length <= 200);
});

test("parsePm2Jlist: detail por processo tem status, restarts, memMb", () => {
  const items = [
    makePm2Item("notion-mcp", "online", 3, 100 * 1024 * 1024),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-classifier", "online"),
    makePm2Item("brain-reindex-nightly", "stopped"),
  ];
  const r = parsePm2Jlist(JSON.stringify(items), DEFAULT_EXPECTED);
  const d = r.detail as Record<string, Record<string, unknown>>;
  assert.strictEqual(d["notion-mcp"].status, "online");
  assert.strictEqual(d["notion-mcp"].restarts, 3);
  assert.ok(typeof d["notion-mcp"].memMb === "number");
  assert.ok((d["notion-mcp"].memMb as number) > 0);
});

test("parsePm2Jlist: brain-reindex-nightly errored → fail (só stopped é normal)", () => {
  const items = [
    makePm2Item("notion-mcp", "online"),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-classifier", "online"),
    makePm2Item("brain-reindex-nightly", "errored"),
  ];
  const r = parsePm2Jlist(JSON.stringify(items), DEFAULT_EXPECTED);
  assert.strictEqual(r.status, "fail");
});

// ---------------------------------------------------------------------------
// pm2Probe (exec fake)
// ---------------------------------------------------------------------------

test("pm2Probe: exec fake ENOENT → skip com error 'pm2 não disponível'", async () => {
  const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const fakeExec = async (_cmd: string, _args: string[], _opts: { timeout: number }) => {
    throw enoent;
  };
  const results = await pm2Probe(fakeExec);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].status, "skip");
  assert.strictEqual(results[0].error, "pm2 não disponível");
});

test("pm2Probe: exec fake retorna jlist válido → ok", async () => {
  const items = [
    makePm2Item("notion-mcp", "online"),
    makePm2Item("brain-indexer", "online"),
    makePm2Item("brain-classifier", "online"),
    makePm2Item("brain-reindex-nightly", "stopped"),
  ];
  const fakeExec = async (_cmd: string, _args: string[], _opts: { timeout: number }) => ({
    stdout: JSON.stringify(items),
  });
  const results = await pm2Probe(fakeExec);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].status, "ok");
});

test("pm2Probe: exec fake lança erro genérico → fail", async () => {
  const fakeExec = async (_cmd: string, _args: string[], _opts: { timeout: number }) => {
    throw new Error("Command failed: timeout");
  };
  const results = await pm2Probe(fakeExec);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].status, "fail");
});
