// tests/e2e/us4-activation.spec.ts
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("checklist de ativação aparece e o passo Tarefas pede o Notion", async ({ page, request }) => {
  await registerAndSignIn(page, request);
  await expect(page.locator("#activation")).toBeVisible();
  await expect(page.locator("#activation-items")).toContainText("Tarefas no Notion");
  // Sem Notion conectado, o sub-bloco de Tarefas orienta a conectar.
  await expect(page.locator("#act-tasks-msg")).toContainText("Notion");
});

test("'Já testei' e 'Pular' persistem após reload", async ({ page, request }) => {
  await registerAndSignIn(page, request);
  await page.click("#act-ask-done");
  // O item ask vira ✅ (recarrega via load()).
  await expect(page.locator("#activation-items")).toContainText("✅ Pergunte ao Zinom");

  await page.click("#act-dismiss");
  // Dismiss esconde o card inteiro.
  await expect(page.locator("#activation")).toBeHidden();

  await page.reload();
  await expect(page.locator("#activation")).toBeHidden(); // persistiu
});
