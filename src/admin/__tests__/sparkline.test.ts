// src/admin/__tests__/sparkline.test.ts
// TDD para renderSparkline — função pura, sem DB, sem I/O. Gera uma polyline
// SVG normalizada a partir de uma série numérica (latência/gauge de 24h).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSparkline } from "../sparkline.js";

test("renderSparkline: série vazia → SVG sem polyline", () => {
  const svg = renderSparkline([]);
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<polyline/);
});

test("renderSparkline: N pontos → polyline com N pares de coordenadas", () => {
  const svg = renderSparkline([1, 2, 3, 4]);
  assert.match(svg, /<svg/);
  assert.match(svg, /<polyline/);
  const m = svg.match(/points="([^"]*)"/);
  assert.ok(m, "polyline deve ter atributo points");
  const pairs = m![1].trim().split(/\s+/).filter(Boolean);
  assert.equal(pairs.length, 4);
  // Cada par é "x,y" com dois números.
  for (const p of pairs) {
    const [x, y] = p.split(",");
    assert.ok(Number.isFinite(Number(x)), `x numérico em ${p}`);
    assert.ok(Number.isFinite(Number(y)), `y numérico em ${p}`);
  }
});

test("renderSparkline: 1 ponto → linha plana (2 pares na meia-altura)", () => {
  const svg = renderSparkline([5], { h: 20 });
  assert.match(svg, /<polyline/);
  const m = svg.match(/points="([^"]*)"/);
  assert.ok(m);
  const pairs = m![1].trim().split(/\s+/).filter(Boolean);
  assert.equal(pairs.length, 2, "um ponto vira uma linha horizontal (2 pares)");
  const ys = pairs.map((p) => Number(p.split(",")[1]));
  assert.equal(ys[0], ys[1], "linha plana: mesmo y nas duas pontas");
  // Meia-altura: valor constante normaliza pro centro do gráfico.
  assert.equal(ys[0], 10);
});

test("renderSparkline: valores NaN/Infinity são filtrados", () => {
  const svg = renderSparkline([1, NaN, 2, Infinity, 3]);
  const m = svg.match(/points="([^"]*)"/);
  assert.ok(m);
  const pairs = m![1].trim().split(/\s+/).filter(Boolean);
  assert.equal(pairs.length, 3, "só os 3 finitos entram");
});

test("renderSparkline: só NaN → SVG sem polyline (como vazio)", () => {
  const svg = renderSparkline([NaN, Infinity, -Infinity]);
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<polyline/);
});

test("renderSparkline: normaliza min→base e max→topo dentro da altura", () => {
  const h = 20;
  const svg = renderSparkline([0, 10], { h, w: 100 });
  const m = svg.match(/points="([^"]*)"/);
  assert.ok(m);
  const pairs = m![1].trim().split(/\s+/).filter(Boolean);
  const ys = pairs.map((p) => Number(p.split(",")[1]));
  // SVG: y cresce pra baixo. Valor máximo deve ficar no topo (y menor),
  // valor mínimo na base (y maior). Margem de 1px nas bordas.
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= h);
  assert.ok(ys[0] > ys[1], "primeiro valor (min) embaixo, segundo (max) em cima");
});

test("renderSparkline: respeita w/h/cls das opções", () => {
  const svg = renderSparkline([1, 2, 3], { w: 80, h: 24, cls: "spark-lat" });
  assert.match(svg, /width="80"/);
  assert.match(svg, /height="24"/);
  assert.match(svg, /class="spark-lat"/);
});

test("renderSparkline: largura padrão usada quando opts ausente", () => {
  const svg = renderSparkline([1, 2]);
  assert.match(svg, /<svg[^>]*width="\d+"/);
  assert.match(svg, /<svg[^>]*height="\d+"/);
});
