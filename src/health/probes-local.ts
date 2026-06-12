// src/health/probes-local.ts
// Probes locais: VPS (métricas do SO), PM2 e Postgres.
// Spec: docs/superpowers/specs/2026-06-11-admin-health-dashboard-design.md

import os from "node:os";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tipos exportados
// ---------------------------------------------------------------------------

export interface VpsNumbers {
  load1: number;
  cores: number;
  memPct: number;
  diskPct: number | null;
  uptimeSec: number;
}

export type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

// ---------------------------------------------------------------------------
// evalVps — avaliador puro (sem I/O)
// ---------------------------------------------------------------------------

export function evalVps(n: VpsNumbers): CheckResult {
  // Limiares com comparação estrita >
  const DISK_WARN = 80;
  const DISK_FAIL = 92;
  const MEM_WARN = 85;
  const MEM_FAIL = 95;

  let status: "ok" | "warn" | "fail" = "ok";

  const setWorse = (s: "warn" | "fail") => {
    if (s === "fail" || status === "ok") status = s;
  };

  // Disco (ignorado quando null)
  if (n.diskPct !== null) {
    if (n.diskPct > DISK_FAIL) setWorse("fail");
    else if (n.diskPct > DISK_WARN) setWorse("warn");
  }

  // Memória
  if (n.memPct > MEM_FAIL) setWorse("fail");
  else if (n.memPct > MEM_WARN) setWorse("warn");

  // Load
  if (n.load1 > n.cores) setWorse("warn");

  // load5, load15 vêm do os.loadavg() [1] e [2]; aqui não estão em VpsNumbers,
  // portanto usamos 0 como placeholder — vpsProbe() os preencherá.
  return {
    checkId: "vps",
    label: "VPS",
    group: "vps",
    status,
    detail: {
      load1: n.load1,
      load5: 0,
      load15: 0,
      cores: n.cores,
      memPct: n.memPct,
      diskPct: n.diskPct,
      uptimeSec: n.uptimeSec,
    },
  };
}

// ---------------------------------------------------------------------------
// parsePm2Jlist — avaliador puro (sem I/O)
// ---------------------------------------------------------------------------

const CRON_PROCESSES = new Set(["brain-reindex-nightly"]);

const DEFAULT_EXPECTED = [
  "notion-mcp",
  "brain-indexer",
  "brain-classifier",
  "brain-reindex-nightly",
];

export function parsePm2Jlist(
  json: string,
  expected: string[] = DEFAULT_EXPECTED,
): CheckResult {
  const base = {
    checkId: "pm2",
    label: "Processos PM2",
    group: "processos" as const,
  };

  // Tenta fazer parse
  let items: unknown[];
  try {
    items = JSON.parse(json) as unknown[];
  } catch (err) {
    const raw = String(err);
    return {
      ...base,
      status: "fail",
      error: raw.slice(0, 200),
    };
  }

  // Indexa por nome
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const i = item as Record<string, unknown>;
    const name = i.name as string;
    byName.set(name, i);
  }

  const detail: Record<string, unknown> = {};
  const missing: string[] = [];
  let failed = false;

  for (const name of expected) {
    const item = byName.get(name);
    if (!item) {
      missing.push(name);
      failed = true;
      continue;
    }

    const env = item.pm2_env as Record<string, unknown>;
    const monit = item.monit as Record<string, unknown>;
    const procStatus = env.status as string;
    const restarts = env.restart_time as number;
    const memMb = Math.round(((monit.memory as number) ?? 0) / (1024 * 1024));

    detail[name] = { status: procStatus, restarts, memMb };

    // brain-reindex-nightly: stopped é ok; qualquer outro estado que não seja online → fail
    const isCron = CRON_PROCESSES.has(name);
    const isOk = isCron ? procStatus === "stopped" || procStatus === "online" : procStatus === "online";
    if (!isOk) {
      failed = true;
    }
  }

  if (missing.length > 0) {
    return {
      ...base,
      status: "fail",
      detail,
      error: `Processos ausentes: ${missing.join(", ")}`,
    };
  }

  return {
    ...base,
    status: failed ? "fail" : "ok",
    detail,
  };
}

// ---------------------------------------------------------------------------
// vpsProbe — coleta números do SO e delega para evalVps
// ---------------------------------------------------------------------------

async function readMemPct(): Promise<number> {
  // Tenta /proc/meminfo (Linux)
  try {
    const raw = await fs.promises.readFile("/proc/meminfo", "utf8");
    const total = parseInt(raw.match(/MemTotal:\s+(\d+)/)?.[1] ?? "0", 10);
    const available = parseInt(raw.match(/MemAvailable:\s+(\d+)/)?.[1] ?? "0", 10);
    if (total > 0) {
      return Math.round(((total - available) / total) * 100 * 10) / 10;
    }
  } catch {
    // fallback para macOS/outros
  }
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100 * 10) / 10;
}

async function readDiskPct(): Promise<number | null> {
  try {
    // Node ≥21 tem fs.promises.statfs
    const statfs = (fs.promises as Record<string, unknown>).statfs as
      | ((path: string) => Promise<{ blocks: bigint; bavail: bigint }>)
      | undefined;
    if (!statfs) return null;
    const s = await statfs("/");
    const blocks = Number(s.blocks);
    const bavail = Number(s.bavail);
    if (blocks === 0) return null;
    return Math.round((1 - bavail / blocks) * 100 * 10) / 10;
  } catch {
    return null;
  }
}

export async function vpsProbe(): Promise<CheckResult[]> {
  try {
    const [loadAvg, memPct, diskPct] = await Promise.all([
      Promise.resolve(os.loadavg()),
      readMemPct(),
      readDiskPct(),
    ]);

    const [load1, load5, load15] = loadAvg;
    const cores = os.cpus().length;
    const uptimeSec = Math.round(os.uptime());

    const result = evalVps({ load1, cores, memPct, diskPct, uptimeSec });

    // Preenche load5/load15 no detail (evalVps não os recebe via VpsNumbers)
    const detail = result.detail as Record<string, unknown>;
    detail.load5 = load5;
    detail.load15 = load15;

    return [result];
  } catch (err) {
    return [
      {
        checkId: "vps",
        label: "VPS",
        group: "vps",
        status: "fail",
        error: String(err).slice(0, 200),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// pm2Probe — executa pm2 jlist e delega para parsePm2Jlist
// ---------------------------------------------------------------------------

const execFileAsync = promisify(_execFile) as unknown as ExecFileFn;

export async function pm2Probe(
  exec: ExecFileFn = execFileAsync,
): Promise<CheckResult[]> {
  try {
    const { stdout } = await exec("pm2", ["jlist"], { timeout: 5000 });
    return [parsePm2Jlist(stdout, DEFAULT_EXPECTED)];
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return [
        {
          checkId: "pm2",
          label: "Processos PM2",
          group: "processos",
          status: "skip",
          error: "pm2 não disponível",
        },
      ];
    }
    return [
      {
        checkId: "pm2",
        label: "Processos PM2",
        group: "processos",
        status: "fail",
        error: String(err).slice(0, 200),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// postgresProbe — mede latência do SELECT 1 + tamanho e conexões do DB
// ---------------------------------------------------------------------------

export async function postgresProbe(): Promise<CheckResult[]> {
  const { getPool } = await import("../rag/storage.js");
  const pool = getPool();

  const t0 = performance.now();
  try {
    await pool.query("SELECT 1");
    const latencyMs = Math.round(performance.now() - t0);

    const { rows } = await pool.query<{ size: string; conns: string }>(
      `SELECT pg_database_size(current_database()) AS size,
              (SELECT numbackends FROM pg_stat_database WHERE datname = current_database()) AS conns`,
    );

    const sizeBytes = parseInt(rows[0].size, 10);
    const connections = parseInt(rows[0].conns, 10);

    return [
      {
        checkId: "postgres",
        label: "Postgres",
        group: "banco",
        status: "ok",
        latencyMs,
        detail: { sizeBytes, connections },
      },
    ];
  } catch (err) {
    return [
      {
        checkId: "postgres",
        label: "Postgres",
        group: "banco",
        status: "fail",
        error: String(err).slice(0, 200),
      },
    ];
  }
}
