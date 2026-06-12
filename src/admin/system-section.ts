// src/admin/system-section.ts
// Seção "Sistema" do admin: painel de saúde server-rendered (sem DB aqui — puro,
// no padrão de renderStatusHtml/renderStripeSection). Recebe um HealthView já
// montado por gather() em routes.ts e devolve o HTML da seção, com seu próprio
// <style> autocontido. Texto pt-BR, tema claro, tokens CSS existentes.
//
// Tiles por grupo de check (vps, processos, banco, entrada, parceiros, créditos).
// Cada tile carrega data-check="<checkId>" e seus valores em [data-field=...]
// para o refresh JS (em routes.ts) atualizar texto e a cor do dot sem reload.
import { escapeHtml, humanizeAge } from "../rag/status.js";
import { formatBytes } from "./business.js";
import { worstStatus, type HealthStatus, type HealthGroup } from "../health/types.js";
import { renderSparkline } from "./sparkline.js";
import type { SampleRow } from "../health/storage.js";

/**
 * Dados prontos para a seção Sistema. Montado em gather() (routes.ts) a partir de
 * latestSamples() + seriesSince(24). series: por checkId, a série numérica de 24h
 * (latência ou gauge) já ordenada por ts asc.
 */
export interface HealthView {
  collectedAt: string | null;
  checks: SampleRow[];
  series: Map<string, number[]>;
}

// Cores do dot de estado (mantêm a identidade: ok usa o verde da marca).
const DOT_COLOR: Record<HealthStatus, string> = {
  ok: "var(--accent)",
  warn: "#c98a00",
  fail: "#b3261e",
  skip: "var(--muted)",
};

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "ok",
  warn: "atenção",
  fail: "falha",
  skip: "não configurado",
};

const GROUP_TITLE: Record<HealthGroup, string> = {
  vps: "VPS",
  processos: "Processos (PM2)",
  banco: "Banco de dados",
  entrada: "Entrada (proxy)",
  parceiros: "Parceiros (APIs)",
  creditos: "Créditos de IA",
};

const GROUP_ORDER: HealthGroup[] = ["vps", "processos", "banco", "entrada", "parceiros", "creditos"];

// --- helpers de detalhe ----------------------------------------------------

/** Lê um número de detail; null/ausente/não-número → undefined. */
function num(detail: Record<string, unknown> | null, key: string): number | undefined {
  const v = detail?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Lê o group gravado no detail (insertSamples sempre grava label/group). */
function groupOf(row: SampleRow): HealthGroup {
  const g = row.detail?.group;
  return (typeof g === "string" ? g : "parceiros") as HealthGroup;
}

/** Lê o label gravado no detail; fallback para o checkId. */
function labelOf(row: SampleRow): string {
  const l = row.detail?.label;
  return typeof l === "string" && l ? l : row.check_id;
}

/** Renderiza o dot colorido de estado para um checkId. */
function dot(status: HealthStatus): string {
  return `<span class="hp-dot" data-field="dot" style="background:${DOT_COLOR[status]}"></span>`;
}

/** Barra estilo .funnel-track (gauge 0..100%). pct null → barra vazia. */
function gauge(label: string, pct: number | null, field: string, warnAt = 80): string {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const txt = pct == null ? "—" : `${pct.toFixed(0)}%`;
  const danger = pct != null && pct >= warnAt;
  const barColor = danger ? "#c98a00" : "var(--accent)";
  return `<div class="hp-gauge">
    <div class="hp-gauge-head"><span class="hp-gauge-label">${escapeHtml(label)}</span><span class="hp-gauge-val" data-field="${escapeHtml(field)}">${txt}</span></div>
    <div class="funnel-track"><div class="funnel-bar" style="width:${clamped}%;background:${barColor}"></div></div>
  </div>`;
}

/** Linha simples rótulo→valor com um data-field. */
function kv(label: string, value: string, field: string): string {
  return `<div class="hp-kv"><span class="hp-kv-l">${escapeHtml(label)}</span><span class="hp-kv-v" data-field="${escapeHtml(field)}">${escapeHtml(value)}</span></div>`;
}

/** Formata latência ms para exibição. */
function fmtLatency(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)} ms`;
}

// --- corpo por grupo -------------------------------------------------------

/** Conteúdo específico de um tile, conforme o group e o shape do detail. */
function tileBody(row: SampleRow, view: HealthView): string {
  const group = groupOf(row);
  const d = row.detail;
  const series = view.series.get(row.check_id) ?? [];

  if (group === "vps") {
    const disk = num(d, "diskPct");
    const mem = num(d, "memPct");
    const load1 = num(d, "load1");
    const cores = num(d, "cores");
    const loadPct = load1 != null && cores != null && cores > 0 ? (load1 / cores) * 100 : null;
    const uptime = num(d, "uptimeSec");
    return `
      ${gauge("Disco", disk ?? null, "diskPct", 85)}
      ${gauge("Memória", mem ?? null, "memPct", 85)}
      ${gauge("Carga (load1/cores)", loadPct, "loadPct", 90)}
      ${kv("Uptime", uptime != null ? humanizeAge(uptime) : "—", "uptimeSec")}`;
  }

  if (group === "processos") {
    // detail = { [nome]: {status, restarts, memMb} }
    const procs = d && typeof d === "object" ? d : {};
    const rows = Object.entries(procs)
      .filter(([k]) => k !== "label" && k !== "group")
      .map(([name, info]) => {
        const o = (info ?? {}) as Record<string, unknown>;
        const st = typeof o.status === "string" ? o.status : "—";
        const restarts = typeof o.restarts === "number" ? o.restarts : "—";
        const memMb = typeof o.memMb === "number" ? `${o.memMb.toFixed(0)} MB` : "—";
        const stBad = st !== "online";
        return `<div class="hp-proc">
          <span class="hp-proc-name">${escapeHtml(name)}</span>
          <span class="hp-proc-st ${stBad ? "bad" : "ok"}">${escapeHtml(st)}</span>
          <span class="hp-proc-meta">${escapeHtml(String(memMb))} · ${escapeHtml(String(restarts))} restarts</span>
        </div>`;
      })
      .join("");
    return rows || `<div class="hp-empty-line muted xs">sem processos reportados</div>`;
  }

  if (group === "banco") {
    const size = num(d, "sizeBytes");
    const conns = num(d, "connections");
    return `
      ${kv("Tamanho", size != null ? formatBytes(size) : "—", "sizeBytes")}
      ${kv("Conexões", conns != null ? String(conns) : "—", "connections")}
      ${kv("Latência", fmtLatency(row.latency_ms), "latencyMs")}
      ${sparklineRow(series, "latência 24h")}`;
  }

  if (group === "entrada") {
    const http = num(d, "httpStatus");
    return `
      ${kv("HTTP", http != null ? String(http) : "—", "httpStatus")}
      ${kv("Latência", fmtLatency(row.latency_ms), "latencyMs")}
      ${sparklineRow(series, "latência 24h")}`;
  }

  if (group === "creditos") {
    // budget:* → {spentUsd, budgetUsd, pct} ; tokens:llm → {inTokens, outTokens}
    if (row.check_id.startsWith("budget:")) {
      const spent = num(d, "spentUsd");
      const budget = num(d, "budgetUsd");
      const pct = num(d, "pct");
      const head = budget != null
        ? `$${(spent ?? 0).toFixed(2)} / $${budget.toFixed(2)}`
        : `$${(spent ?? 0).toFixed(2)} (sem orçamento)`;
      return `
        ${kv("Gasto no mês", head, "spentUsd")}
        ${gauge("Uso do orçamento", pct ?? null, "pct", 80)}`;
    }
    // tokens:llm
    const inTok = num(d, "inTokens");
    const outTok = num(d, "outTokens");
    return `
      ${kv("Tokens entrada", inTok != null ? inTok.toLocaleString("pt-BR") : "—", "inTokens")}
      ${kv("Tokens saída", outTok != null ? outTok.toLocaleString("pt-BR") : "—", "outTokens")}`;
  }

  // parceiros: stripe tem detail de saldo; os demais são latência pura.
  if (row.check_id === "stripe") {
    const available = Array.isArray(d?.available) ? (d!.available as Array<Record<string, unknown>>) : [];
    const avail = available
      .map((a) => {
        const amt = typeof a.amount === "number" ? a.amount : 0;
        const cur = typeof a.currency === "string" ? a.currency.toUpperCase() : "";
        return `${(amt / 100).toFixed(2)} ${escapeHtml(cur)}`;
      })
      .join(", ");
    return `
      ${kv("Saldo disponível", avail || "—", "available")}
      ${kv("Latência", fmtLatency(row.latency_ms), "latencyMs")}`;
  }

  return `
    ${kv("Latência", fmtLatency(row.latency_ms), "latencyMs")}
    ${sparklineRow(series, "latência 24h")}`;
}

/** Sparkline com legenda; série vazia mostra placeholder textual. */
function sparklineRow(series: number[], legend: string): string {
  const finite = series.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return `<div class="hp-spark"><span class="hp-spark-legend muted xs">${escapeHtml(legend)}: sem dados</span></div>`;
  }
  return `<div class="hp-spark">
    ${renderSparkline(finite, { w: 120, h: 22, cls: "hp-spark-svg" })}
    <span class="hp-spark-legend muted xs">${escapeHtml(legend)}</span>
  </div>`;
}

/** Um tile de check. */
function renderTile(row: SampleRow): string {
  return `<div class="hp-tile" data-check="${escapeHtml(row.check_id)}">
    <div class="hp-tile-head">
      ${dot(row.status)}
      <span class="hp-tile-title">${escapeHtml(labelOf(row))}</span>
      <span class="hp-tile-state" data-field="state">${escapeHtml(STATUS_LABEL[row.status])}</span>
    </div>
    <div class="hp-tile-body">{{BODY}}</div>
  </div>`;
}

/**
 * Renderiza a seção Sistema completa. Pura: nenhum acesso a DB ou env.
 * Sem nenhuma amostra → estado vazio amigável.
 */
export function renderSystemSection(h: HealthView, token: string): string {
  const runAction = `/admin/health/run?token=${encodeURIComponent(token)}`;
  const collectedLabel = h.collectedAt
    ? new Date(h.collectedAt).toLocaleString("pt-BR")
    : "nunca";

  const style = `<style>
/* --- Sistema (painel de saúde) --- */
.hp-overall{
  display:flex;align-items:center;gap:16px;
  background:var(--bg);border:1px solid var(--line);border-radius:var(--r);
  box-shadow:var(--shadow-sm);padding:18px 22px;margin-bottom:18px;flex-wrap:wrap;
}
.hp-overall-main{display:flex;align-items:center;gap:14px;flex:1;min-width:240px}
.hp-overall-dot{width:14px;height:14px;border-radius:999px;flex:0 0 auto}
.hp-overall-txt{display:flex;flex-direction:column;gap:2px}
.hp-overall-state{font-size:18px;font-weight:700;letter-spacing:-.02em;color:var(--ink)}
.hp-overall-sub{font-size:12px;color:var(--muted)}
.hp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:14px}
.hp-group{margin-top:22px}
.hp-group:first-of-type{margin-top:0}
.hp-group-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 10px}
.hp-tile{
  background:var(--bg);border:1px solid var(--line);border-radius:var(--r-sm);
  box-shadow:var(--shadow-sm);padding:13px 15px;
}
.hp-tile-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.hp-dot{width:9px;height:9px;border-radius:999px;flex:0 0 auto}
.hp-tile-title{font-size:13.5px;font-weight:600;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-tile-state{font-size:11px;color:var(--muted);white-space:nowrap}
.hp-tile-body{display:flex;flex-direction:column;gap:8px}
.hp-gauge-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;gap:8px}
.hp-gauge-label{font-size:12px;color:var(--ink-soft)}
.hp-gauge-val{font-size:12px;font-weight:600;color:var(--ink);white-space:nowrap}
.hp-kv{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:12.5px}
.hp-kv-l{color:var(--ink-soft)}
.hp-kv-v{font-weight:600;color:var(--ink);font-family:var(--mono);font-size:12px;text-align:right}
.hp-proc{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap}
.hp-proc-name{font-weight:600;color:var(--ink)}
.hp-proc-st{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.hp-proc-st.ok{background:var(--accent-soft);color:var(--accent-strong);border-color:rgba(31,139,76,.2)}
.hp-proc-st.bad{background:#fdecec;color:#9a2820;border-color:rgba(154,40,32,.2)}
.hp-proc-meta{color:var(--muted);font-size:11px;margin-left:auto}
.hp-spark{display:flex;align-items:center;gap:8px}
.hp-spark-svg{stroke:var(--accent);stroke-width:1.5;display:block}
.hp-spark-legend{white-space:nowrap}
.hp-empty{
  background:var(--paper);border:1px dashed var(--line-2);border-radius:var(--r);
  padding:28px 22px;text-align:center;color:var(--muted);font-size:13.5px;
}
</style>`;

  // Estado vazio: collector ainda não rodou.
  if (h.checks.length === 0) {
    return `<section class="section" id="sistema">
  ${style}
  <div class="section-header">
    <h2 class="section-title">Sistema</h2>
    <p class="section-desc">Saúde da infraestrutura, processos, banco, parceiros e créditos de IA. Coletado periodicamente; clique em "Atualizar agora" para forçar uma coleta.</p>
  </div>
  <form method="POST" action="${escapeHtml(runAction)}" style="margin-bottom:16px">
    <button type="submit">Atualizar agora</button>
  </form>
  <div class="hp-empty">O collector ainda não rodou. Clique em "Atualizar agora" para a primeira coleta.</div>
</section>`;
  }

  const overall = worstStatus(h.checks.map((c) => c.status));
  const overallLabel = STATUS_LABEL[overall];
  const counts = h.checks.reduce<Record<HealthStatus, number>>(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0, skip: 0 },
  );

  // Agrupa por group, na ordem canônica; dentro do grupo, ordena por checkId.
  const byGroup = new Map<HealthGroup, SampleRow[]>();
  for (const row of h.checks) {
    const g = groupOf(row);
    const arr = byGroup.get(g) ?? [];
    arr.push(row);
    byGroup.set(g, arr);
  }

  const groupsHtml = GROUP_ORDER.filter((g) => byGroup.has(g))
    .map((g) => {
      const rows = (byGroup.get(g) ?? []).sort((a, b) => a.check_id.localeCompare(b.check_id));
      const tiles = rows.map((r) => renderTile(r).replace("{{BODY}}", tileBody(r, h))).join("\n");
      return `<div class="hp-group">
    <h3 class="hp-group-title">${escapeHtml(GROUP_TITLE[g])}</h3>
    <div class="hp-grid">${tiles}</div>
  </div>`;
    })
    .join("\n");

  return `<section class="section" id="sistema">
  ${style}
  <div class="section-header">
    <h2 class="section-title">Sistema</h2>
    <p class="section-desc">Saúde da infraestrutura, processos, banco, parceiros e créditos de IA. Estado agregado abaixo; cada bloco mostra o último resultado coletado. Atualiza sozinho a cada 60 s.</p>
  </div>
  <div class="hp-overall" data-check="__overall__">
    <div class="hp-overall-main">
      <span class="hp-overall-dot" data-field="dot" style="background:${DOT_COLOR[overall]}"></span>
      <div class="hp-overall-txt">
        <span class="hp-overall-state" data-field="state">${escapeHtml(overallLabel)}</span>
        <span class="hp-overall-sub"><span data-field="counts">${counts.ok} ok · ${counts.warn} atenção · ${counts.fail} falha · ${counts.skip} não conf.</span> · coletado ${escapeHtml(collectedLabel)}</span>
      </div>
    </div>
    <form method="POST" action="${escapeHtml(runAction)}" style="margin:0">
      <button type="submit">Atualizar agora</button>
    </form>
  </div>
  ${groupsHtml}
</section>`;
}
