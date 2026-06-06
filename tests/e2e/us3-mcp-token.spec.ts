// tests/e2e/us3-mcp-token.spec.ts — a signed-in friend generates their per-account
// MCP access token and gets a ready-to-paste setup command for their AI client.
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

test("friend generates an MCP token and a ready-to-paste connect command", async ({ page, request }) => {
  await registerAndSignIn(page, request);

  // The MCP endpoint URL is shown and the generate button is present.
  await expect(page.locator("#mcp-url")).not.toHaveText("—");

  // Generate the token.
  await page.click("#mcp-gen");
  await expect(page.locator("#mcp-result")).toBeVisible({ timeout: 10000 });

  const token = await page.locator("#mcp-token").inputValue();
  expect(token).toMatch(/^acct_[0-9a-f]{48}$/);

  const cmd = await page.locator("#mcp-cmd").inputValue();
  expect(cmd).toContain("claude mcp add");
  expect(cmd).toContain(token);
  expect(cmd).toContain("/mcp");

  // The token is persisted server-side (only its hash) — /portal/me reflects it.
  const me = await page.context().request.get("/portal/me");
  const body = await me.json();
  expect(body.mcp.configured).toBe(true);
  expect(body.mcp.url).toContain("/mcp");
});
