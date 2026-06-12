// src/admin/sparkline.ts
// Sparkline SVG puro (sem DB, sem I/O) para a seção Sistema do admin. Recebe uma
// série numérica (latência ou gauge das últimas 24h) e devolve uma <polyline>
// normalizada à caixa w×h. Valores não-finitos (NaN/Infinity) são descartados;
// série vazia (ou só não-finitos) vira um SVG sem polyline (placeholder).
import { escapeHtml } from "../rag/status.js";

export interface SparklineOpts {
  /** Largura do viewBox em px (padrão 96). */
  w?: number;
  /** Altura do viewBox em px (padrão 24). */
  h?: number;
  /** Classe CSS aplicada ao <svg> (para estilizar o stroke por grupo). */
  cls?: string;
}

const DEFAULT_W = 96;
const DEFAULT_H = 24;
// Margem vertical para o stroke não encostar nas bordas do viewBox.
const PAD = 1;

/**
 * Renderiza uma sparkline como string SVG.
 *
 * - Série vazia (ou só valores não-finitos) → SVG sem polyline.
 * - 1 ponto → linha horizontal na meia-altura (não há variação a mostrar).
 * - N pontos → polyline com N pares "x,y", x distribuído uniformemente e y
 *   normalizado [min..max] → [base..topo] (eixo SVG cresce pra baixo, então o
 *   máximo recebe o menor y).
 */
export function renderSparkline(points: number[], opts: SparklineOpts = {}): string {
  const w = opts.w ?? DEFAULT_W;
  const h = opts.h ?? DEFAULT_H;
  const clsAttr = opts.cls ? ` class="${escapeHtml(opts.cls)}"` : "";
  const open = `<svg${clsAttr} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" fill="none" aria-hidden="true">`;

  const vals = points.filter((v) => Number.isFinite(v));
  if (vals.length === 0) {
    // Placeholder vazio: caixa sem polyline (a UI mostra "sem dados" ao lado).
    return `${open}</svg>`;
  }

  const mid = h / 2;
  if (vals.length === 1) {
    // Um ponto: linha plana na meia-altura, de ponta a ponta.
    const y = round(mid);
    const pts = `0,${y} ${w},${y}`;
    return `${open}<polyline points="${pts}" /></svg>`;
  }

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;
  const usableH = h - PAD * 2;

  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      // Sem variação (todos iguais): centraliza. Senão normaliza e inverte o
      // eixo (SVG y cresce pra baixo: max no topo = PAD, min na base).
      const norm = span === 0 ? 0.5 : (v - min) / span;
      const y = PAD + (1 - norm) * usableH;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");

  return `${open}<polyline points="${pts}" /></svg>`;
}

/** Arredonda para 2 casas, sem zeros à direita inúteis. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
