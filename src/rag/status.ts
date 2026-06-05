// src/rag/status.ts
// Pure observability helpers (NO DB import) so they are unit-testable without a
// Postgres connection. The DB query (getStatus in storage.ts) is a thin shell
// around summarizeStatus(); recordRun writes the rows summarizeStatus reads.
//
// Why this exists: a dead source must never be silent again. The indexer and
// classifier append one status_runs row per source per run; /status and the
// stale-source alert read the LATEST row per (worker, source) so a token that
// quietly indexes 0, or a calendar feed that stopped, surfaces as stale/failing.

/**
 * Staleness threshold (seconds) for a source's last successful run.
 * Default 3h — the indexer cron runs hourly ("0 * * * *"), so >3h without a
 * run means ~3 consecutive missed ticks: a real outage, not a single blip.
 */
export const STALE_THRESHOLD_SECONDS = 3 * 60 * 60; // 10800s = 3h

/** Pure: is a source stale given its age and a threshold? Strict greater-than. */
export function staleness(
  ageSeconds: number,
  thresholdSeconds: number = STALE_THRESHOLD_SECONDS,
): boolean {
  return ageSeconds > thresholdSeconds;
}

/** Raw latest-row shape returned by getStatus's DB query (one per worker+source). */
export interface StatusRow {
  worker: string;
  source: string;
  ok: boolean;
  counts: unknown;
  error: string | null;
  last_run_at: Date;
  /** Best-effort merge of sync_state.last_sync_at for the mapped source (or null). */
  sync_last_at: Date | null;
}

/** /status payload entry — age/stale computed, dates serialized to ISO. */
export interface StatusSource {
  worker: string;
  source: string;
  ok: boolean;
  last_run_at: string;
  sync_last_at: string | null;
  age_seconds: number;
  stale: boolean;
  counts: unknown;
  error: string | null;
}

/**
 * Pure: map raw latest-rows to the /status payload, computing age_seconds and
 * stale relative to `now`. No DB, no I/O — fully unit-testable with fixtures.
 * Clock skew (last_run_at slightly ahead of now) clamps age to 0.
 */
export function summarizeStatus(
  rows: StatusRow[],
  now: Date = new Date(),
  thresholdSeconds: number = STALE_THRESHOLD_SECONDS,
): StatusSource[] {
  return rows.map((r) => {
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - r.last_run_at.getTime()) / 1000));
    return {
      worker: r.worker,
      source: r.source,
      ok: r.ok,
      last_run_at: r.last_run_at.toISOString(),
      sync_last_at: r.sync_last_at ? r.sync_last_at.toISOString() : null,
      age_seconds: ageSeconds,
      stale: staleness(ageSeconds, thresholdSeconds),
      counts: r.counts,
      error: r.error,
    };
  });
}

// --- F2.5: mini-dashboard (HTML view of /status) ----------------------------
// Pure renderer (NO DB, NO I/O) so it is unit-testable with fixtures, mirroring
// summarizeStatus. The /status route content-negotiates: HTML for a browser,
// JSON otherwise. Same data, same bearer auth — this is just a friendlier face.

/** Escape the 5 HTML-significant chars so source names / errors can't inject markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Humanize an age in seconds to a compact "2h 3m" / "45s" string. */
export function humanizeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hrem = h % 24;
  return hrem ? `${d}d ${hrem}h` : `${d}d`;
}

/** Compact one-line summary of a counts blob (e.g. {documents,chunks}). */
function formatCounts(counts: unknown): string {
  if (counts == null || typeof counts !== "object") return "—";
  const entries = Object.entries(counts as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `${k}=${v}`);
  return entries.length ? entries.join(" · ") : "—";
}

/**
 * Pure: render the /status payload as a small self-contained HTML page.
 * Inline CSS, no external assets, 30s auto-refresh. Rows for a failing (!ok)
 * or stale source get a colored class so a dead feed jumps out at a glance.
 */
export function renderStatusHtml(now: string, sources: StatusSource[]): string {
  const problems = sources.filter((s) => !s.ok || s.stale);
  const banner = problems.length
    ? `<div class="banner bad">⚠ ${problems.length} fonte(s) com problema: ${escapeHtml(
        problems.map((s) => s.source).join(", "),
      )}</div>`
    : `<div class="banner ok">✓ Todas as fontes saudáveis</div>`;

  const rows = sources
    .map((s) => {
      const cls = !s.ok ? "fail" : s.stale ? "stale" : "good";
      const state = !s.ok ? "FALHA" : s.stale ? "PARADA" : "ok";
      return `<tr class="${cls}">
        <td>${escapeHtml(s.source)}</td>
        <td>${escapeHtml(s.worker)}</td>
        <td class="state">${state}</td>
        <td>${escapeHtml(humanizeAge(s.age_seconds))}</td>
        <td>${escapeHtml(formatCounts(s.counts))}</td>
        <td class="err">${s.error ? escapeHtml(s.error) : ""}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Saúde do Cérebro</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .ts { color: #888; font-size: 13px; margin-bottom: 16px; }
  .banner { padding: 10px 14px; border-radius: 8px; font-weight: 600; margin-bottom: 16px; }
  .banner.ok { background: #1f8b4c22; color: #1f8b4c; }
  .banner.bad { background: #d83a3a22; color: #d83a3a; }
  table { border-collapse: collapse; width: 100%; max-width: 960px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #8884; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  td.state { font-weight: 700; }
  tr.good td.state { color: #1f8b4c; }
  tr.stale td.state { color: #c98a00; }
  tr.fail td.state { color: #d83a3a; }
  tr.fail, tr.stale { background: #d83a3a0c; }
  td.err { color: #d83a3a; font-family: ui-monospace, monospace; font-size: 12px; max-width: 320px; word-break: break-word; }
</style>
</head>
<body>
  <h1>🧠 Saúde do Cérebro</h1>
  <div class="ts">Atualizado: ${escapeHtml(now)} · auto-refresh 30s</div>
  ${banner}
  <table>
    <thead><tr><th>Fonte</th><th>Worker</th><th>Estado</th><th>Idade</th><th>Contagens</th><th>Erro</th></tr></thead>
    <tbody>
${rows || '<tr><td colspan="6">Sem runs registrados ainda.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}
