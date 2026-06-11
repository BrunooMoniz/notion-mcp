// tests/e2e/us5-tasks-guide.spec.ts — 003-tasks-v1: the new-user onboarding
// offers the tasks choice (use an existing Notion base vs create the standard
// Zinom Kanban), and the Guia teaches the tasks+planning flow linearly.
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("onboarding novo tem o passo de tarefas com escolha dupla; sem Notion orienta a conectar", async ({
  page,
  request,
}) => {
  await registerAndSignIn(page, request);

  // Fresh account → estado "novo" → onboarding with 5 steps; the tasks step
  // exists but its choice only shows when the step is the current one.
  await expect(page.locator("#onb-steps")).toContainText("Onde suas tarefas vivem");

  // Connect a source (iCal) so step 2 completes and the tasks step activates.
  const icalRes = await page.context().request.post("/portal/ical", {
    data: { url: "https://calendar.example.com/us5/basic.ics", label: "US5" },
  });
  expect(icalRes.ok()).toBeTruthy();
  await page.reload();

  await expect(page.locator("#onb-steps")).toContainText("Já tenho uma base no Notion");
  await expect(page.locator("#onb-steps")).toContainText("Criar o Kanban padrão Zinom");

  // Without Notion connected, detect guides the user to connect it first.
  await page.click("#onb-steps [data-tasks-detect]");
  await expect(page.locator("#onb-steps .js-tasks-msg")).toContainText("Conecte seu Notion em Fontes", {
    timeout: 10000,
  });
});

test("Guia tem a seção Tarefas e planejamento com os 4 capítulos e prompts copiáveis", async ({
  page,
  request,
}) => {
  await registerAndSignIn(page, request);
  await page.click('.sidebar-nav [data-nav="guia"]');

  const sec = page.locator("#guia-tarefas");
  await expect(sec).toBeAttached();
  await expect(page.locator("#view-guia")).toContainText("Onde suas tarefas vivem");
  await expect(page.locator("#view-guia")).toContainText("Da reunião para a tarefa");
  await expect(page.locator("#view-guia")).toContainText("Planejar dia, semana e mês");
  await expect(page.locator("#view-guia")).toContainText("manter o board vivo", {
    ignoreCase: true,
  });

  // The meeting→tasks prompt is copyable (fazer vs cobrar flow).
  await expect(page.locator("#view-guia [data-copy*='COBRAR']").first()).toBeAttached();
});
