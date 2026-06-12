// tests/e2e/grafo-v2.spec.ts — Grafo v2: chips de preset acima do canvas,
// seletor de período combinável e empty state preservado. A API do grafo é
// mockada via page.route com uma fixture de 6 nós / 4 arestas que exercita
// group (comunidades), recent (Recentes) e last_seen (Cronologia); o teste
// valida os query params enviados (group_by=community na carga inicial,
// days=30 ao ativar Recentes) e salva um screenshot do grafo renderizado.
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

const GRAPH_FIXTURE = {
  mode: "overview",
  nodes: [
    { id: "e:1", kind: "entity", label: "Ana", type: "pessoa", weight: 9, url: null, group: 0, recent: 4, last_seen: "2026-06-10" },
    { id: "e:2", kind: "entity", label: "Bruno", type: "pessoa", weight: 7, url: null, group: 0, recent: 2, last_seen: "2026-06-01" },
    { id: "e:3", kind: "entity", label: "Zinom", type: "projeto", weight: 12, url: null, group: 1, recent: 6, last_seen: "2026-06-11" },
    { id: "e:4", kind: "entity", label: "Nora", type: "empresa", weight: 5, url: null, group: 1, recent: 0, last_seen: "2026-03-01" },
    { id: "e:5", kind: "entity", label: "GlobalCripto", type: "empresa", weight: 4, url: null, group: 2, recent: 1, last_seen: "2026-05-20" },
    { id: "e:6", kind: "entity", label: "Talos", type: "projeto", weight: 3, url: null, group: 2, recent: 0, last_seen: null },
  ],
  edges: [
    { a: "e:1", b: "e:3", weight: 5 },
    { a: "e:2", b: "e:3", weight: 3 },
    { a: "e:2", b: "e:4", weight: 2 },
    { a: "e:5", b: "e:6", weight: 1 },
  ],
};

test("grafo v2: chips renderizam; Recentes refaz GET com days=30; screenshot", async ({
  page,
  request,
}) => {
  const graphCalls: string[] = [];
  await page.route("**/portal/brain/graph*", async (route) => {
    graphCalls.push(route.request().url());
    await route.fulfill({ json: GRAPH_FIXTURE });
  });

  await registerAndSignIn(page, request);
  await page.click('.sidebar-nav [data-nav="atividade"]');
  await page.click("#brain-toggle-grafo");

  // Chips renderizam; "Visão geral" ativo por default; seletor em "Tudo".
  await expect(page.locator("#graph-presets .graph-preset")).toHaveCount(6);
  await expect(page.locator('#graph-presets [data-preset="overview"]')).toHaveClass(/active/);
  await expect(page.locator('#graph-period [data-days="0"]')).toHaveClass(/active/);

  // Carga inicial pede agrupamento por comunidade.
  await expect.poll(() => graphCalls.length).toBeGreaterThan(0);
  expect(graphCalls[0]).toContain("mode=overview");
  expect(graphCalls[0]).toContain("group_by=community");

  // Clicar em Recentes ativa o chip, puxa o seletor para 30d e refaz o GET com days=30.
  await page.click('#graph-presets [data-preset="recentes"]');
  await expect(page.locator('#graph-presets [data-preset="recentes"]')).toHaveClass(/active/);
  await expect(page.locator('#graph-period [data-days="30"]')).toHaveClass(/active/);
  await expect.poll(() => graphCalls.length).toBeGreaterThan(1);
  expect(graphCalls[graphCalls.length - 1]).toContain("days=30");
  expect(graphCalls[graphCalls.length - 1]).not.toContain("group_by=community");

  // Período combinável: 90d refaz o GET com days=90.
  await page.click('#graph-period [data-days="90"]');
  await expect.poll(() => graphCalls.length).toBeGreaterThan(2);
  expect(graphCalls[graphCalls.length - 1]).toContain("days=90");

  // Grafo visível com a fixture; screenshot depois da física assentar.
  await expect(page.locator("#brain-graph-wrap")).toBeVisible();
  await expect(page.locator("#brain-graph-empty")).toBeHidden();
  await page.waitForTimeout(3500); // cola: maxSimulationTime 2500ms + fit animado
  await page.locator("#brain-graph-wrap").screenshot({ path: "test-results/grafo-v2.png" });
});

test("grafo v2: empty state preservado quando a API devolve zero nós", async ({
  page,
  request,
}) => {
  await page.route("**/portal/brain/graph*", (route) =>
    route.fulfill({ json: { mode: "overview", nodes: [], edges: [] } }),
  );

  await registerAndSignIn(page, request);
  await page.click('.sidebar-nav [data-nav="atividade"]');
  await page.click("#brain-toggle-grafo");

  await expect(page.locator("#brain-graph-empty")).toBeVisible();
  await expect(page.locator("#brain-graph-wrap")).toBeHidden();
});
