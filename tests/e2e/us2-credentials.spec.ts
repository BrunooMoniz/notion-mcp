// tests/e2e/us2-credentials.spec.ts — User Story 2: a signed-in friend manages
// their own credentials (iCal link + Granola key), and the secrets are stored
// but only ever shown masked (never the raw secret).
import { test, expect } from "@playwright/test";
import { registerAndSignIn } from "./helpers.js";

const ICAL_URL = "https://calendar.google.com/calendar/ical/e2e-secret/basic.ics";
const GRANOLA_KEY = "granola-e2e-key-1234";

test("friend saves an iCal link and Granola key; secrets stored masked", async ({
  page,
  request,
}) => {
  await registerAndSignIn(page, request);

  // Add an iCal link.
  await page.fill("#ical-url", ICAL_URL);
  await page.click("#ical-form button[type=submit]");

  // Set the Granola key.
  await page.fill("#granola-key", GRANOLA_KEY);
  await page.click("#granola-form button[type=submit]");

  // Reload to render the persisted, masked state from /portal/me.
  await page.reload();
  await expect(page.locator("#who")).toHaveText(/Conectado como/, { timeout: 10000 });

  // iCal link appears (masked) and the raw secret is NOT in the DOM anywhere.
  await expect(page.locator("#ical-list .row")).toHaveCount(1);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("e2e-secret");

  // Granola tag shows it's set: last-4 mask "1234" (maskToken) -> "chave ••••1234".
  await expect(page.locator("#granola-tag")).toHaveClass(/ok/);
  await expect(page.locator("#granola-tag")).toContainText("1234");

  // Direct API check with the browser's session cookies.
  const res = await page.context().request.get("/portal/sources");
  expect(res.ok()).toBeTruthy();
  const raw = await res.text();
  expect(raw).not.toContain("e2e-secret");

  const sources = JSON.parse(raw);
  expect(sources.granola.set).toBe(true);
  expect(Array.isArray(sources.ical.links)).toBe(true);
  expect(sources.ical.links.length).toBeGreaterThanOrEqual(1);
});
