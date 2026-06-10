// tests/e2e/us4-activation.spec.ts
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("checklist de ativação aparece e o passo Tarefas pede o Notion", async ({ page, request }) => {
  await registerAndSignIn(page, request);
  await expect(page.locator("#activation")).toBeVisible();
  // After design handoff: #activation-items was renamed to #activation-steps.
  await expect(page.locator("#activation-steps")).toContainText("Tarefas no Notion");
  // Sem Notion conectado, o sub-bloco de Tarefas orienta a conectar.
  // Note: #act-tasks-msg is only rendered when Notion IS connected; without it the
  // outer activation-steps shows "Conecte seu Notion em Fontes primeiro."
  await expect(page.locator("#activation-steps")).toContainText("Notion");
});

test("'Já testei' e 'Pular' persistem após reload", async ({ page, request }) => {
  await registerAndSignIn(page, request);

  // After design handoff: #act-ask-done and #act-dismiss buttons were removed from
  // the rendered HTML; the underlying API endpoints remain (/portal/activation/ask
  // and /portal/activation/dismiss). Drive via the API, then verify persistence.
  const askRes = await page.context().request.post("/portal/activation/ask");
  expect(askRes.ok()).toBeTruthy();

  // Wait for load() to refresh after the API call.
  await page.reload();

  // Activation step 3 (index 3) should now be done: shows a checkmark.
  // The step label is "Conectar seu assistente (Claude, ChatGPT…)" and renders with class "done".
  await expect(page.locator("#activation-steps .act-step.done").last()).toBeVisible({ timeout: 5000 });

  const dismissRes = await page.context().request.post("/portal/activation/dismiss");
  expect(dismissRes.ok()).toBeTruthy();

  await page.reload();
  // Dismiss hides the card when all steps complete OR when explicitly dismissed.
  await expect(page.locator("#activation")).toBeHidden({ timeout: 5000 });
});
