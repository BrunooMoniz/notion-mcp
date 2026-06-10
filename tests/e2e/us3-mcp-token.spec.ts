// tests/e2e/us3-mcp-token.spec.ts — a signed-in friend generates their per-account
// MCP access token and gets a ready-to-paste setup command for their AI client.
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("friend generates an MCP token and a ready-to-paste connect command", async ({ page, request }) => {
  await registerAndSignIn(page, request);

  // v2: connecting an AI lives in the Guia view, in per-assistant tabs.
  await page.click('.sidebar-nav [data-nav="guia"]');

  // The Claude.ai panel shows the real MCP URL (filled from /portal/me).
  await expect(page.locator("#endpoint-claudeai")).toContainText("/mcp");

  // Token generation lives in the Claude Code tab.
  await page.click('.ai-tab[data-ai="claudecode"]');
  await page.click("#token-gen-btn");

  // After design handoff: #mcp-result was replaced by #token-area which renders
  // the token in a .tk element and the command in a .code-block.
  await expect(page.locator("#token-area .tk")).toBeVisible({ timeout: 10000 });

  const tokenText = await page.locator("#token-area .tk").innerText();
  expect(tokenText).toMatch(/^acct_[0-9a-f]{48}$/);

  const cmdText = await page.locator("#token-area .code-block").innerText();
  expect(cmdText).toContain("claude mcp add");
  expect(cmdText).toContain(tokenText.trim());
  expect(cmdText).toContain("/mcp");

  // The token is persisted server-side (only its hash) — /portal/me reflects it.
  const me = await page.context().request.get("/portal/me");
  const body = await me.json();
  expect(body.mcp.configured).toBe(true);
  expect(body.mcp.url).toContain("/mcp");
});
