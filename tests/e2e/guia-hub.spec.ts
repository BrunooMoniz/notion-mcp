// tests/e2e/guia-hub.spec.ts — Frente E (#100): o Guia virou um hub paginado.
// O hub mantém o card "Verificar minha configuração" e lista um card por
// seção; cada card abre uma subpágina própria (#guia/conectar etc.) com
// "← Guia" para voltar; deep-links antigos (#guia-conectar / #guia-tarefas)
// redirecionam para a subpágina nova.
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("hub do Guia renderiza diagnóstico + 5 cards; card abre subpágina; ← Guia volta", async ({
  page,
  request,
}) => {
  await registerAndSignIn(page, request);
  await page.click('.sidebar-nav [data-nav="guia"]');

  // Hub: card de diagnóstico permanece + um card por seção.
  await expect(page.locator("#view-guia")).toBeVisible();
  await expect(page.locator("#diag-card")).toBeVisible();
  await expect(page.locator("#guia-hub .guia-hub-card")).toHaveCount(5);
  for (const title of [
    "Conectar sua IA",
    "Tarefas e Planejamento",
    "Receitas para o dia a dia",
    "Resolver Problemas",
    "Como o Zinom Funciona",
  ]) {
    await expect(page.locator("#guia-hub")).toContainText(title);
  }

  // Clique navega à subpágina; conteúdo existente preservado; sidebar segue em Guia.
  await page.click('#guia-hub [data-guia="conectar"]');
  await expect(page.locator("#view-guia-conectar")).toBeVisible();
  await expect(page.locator("#view-guia")).toBeHidden();
  await expect(page).toHaveURL(/#guia\/conectar$/);
  await expect(page.locator("#connect-guided")).toBeVisible();
  await expect(page.locator('.sidebar-nav [data-nav="guia"]')).toHaveClass(/active/);

  // "← Guia" volta ao hub.
  await page.click("#view-guia-conectar .guia-back");
  await expect(page.locator("#view-guia")).toBeVisible();
  await expect(page.locator("#view-guia-conectar")).toBeHidden();
  await expect(page).toHaveURL(/#guia$/);

  // Receitas: o filtro continua funcionando dentro da subpágina.
  await page.click('#guia-hub [data-guia="receitas"]');
  await expect(page.locator("#view-guia-receitas")).toBeVisible();
  await page.click('#recipe-filters [data-rcat="agenda"]');
  await expect(
    page.locator('#recipe-grid .recipe-card[data-rcat="agenda"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('#recipe-grid .recipe-card[data-rcat="tarefas"]').first(),
  ).toBeHidden();
});

test("deep-link antigo #guia-conectar redireciona para #guia/conectar (hashchange e boot)", async ({
  page,
  request,
}) => {
  await registerAndSignIn(page, request);

  // Via hashchange (navegação dentro do app).
  await page.goto("/app.html#guia-conectar");
  await expect(page.locator("#view-guia-conectar")).toBeVisible();
  await expect(page).toHaveURL(/#guia\/conectar$/);

  // Via boot (rota inicial com a subpágina nova no hash).
  await page.reload();
  await expect(page.locator("#view-guia-conectar")).toBeVisible();
  await expect(page).toHaveURL(/#guia\/conectar$/);

  // #guia-tarefas também redireciona.
  await page.goto("/app.html#guia-tarefas");
  await expect(page.locator("#view-guia-tarefas")).toBeVisible();
  await expect(page).toHaveURL(/#guia\/tarefas$/);
});
