// tests/e2e/us1-invite-magic-link.spec.ts — User Story 1: invite + magic-link
// sign-in. Covers the generic (no-leak) negative path, the happy path, and the
// single-use guarantee of the magic link.
import { test, expect } from "@playwright/test";
import { seedInvite, getLastMagicLink, uniqueEmail } from "./helpers.js";

test.describe("US1 — invite + magic link", () => {
  test("bogus invite gives a generic confirmation but creates no account", async ({
    page,
    request,
  }) => {
    const email = uniqueEmail("bogus");

    await page.goto("/");
    await page.fill("#invite", "bogus-code");
    await page.fill("#reg-email", email);
    await page.click("#register-form button[type=submit]");

    // Generic "link sent" confirmation regardless of invite validity (no leak).
    await expect(page.locator("#sent")).toBeVisible();

    // No account => no session. app.js redirects to "/" when /portal/me is 401.
    await page.goto("/app.html");
    await page.waitForURL((url) => url.pathname === "/", { timeout: 10000 });
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("valid invite issues a magic link that signs the friend in", async ({ page, request }) => {
    const code = await seedInvite();
    const email = uniqueEmail("valid");

    await page.goto("/");
    await page.fill("#invite", code);
    await page.fill("#reg-email", email);
    await page.click("#register-form button[type=submit]");
    await expect(page.locator("#sent")).toBeVisible();

    const link = await getLastMagicLink(request);
    expect(link).toContain("/portal/verify?token=");

    await page.goto(link);
    await page.waitForURL("**/app.html**", { timeout: 10000 });
    // After design handoff: #who was replaced by #user-email (email text only, no prefix).
    await expect(page.locator("#user-email")).toHaveText(email, { timeout: 10000 });
  });

  test("the magic link is single-use", async ({ page, request }) => {
    const code = await seedInvite();
    const email = uniqueEmail("single");

    await page.goto("/");
    await page.fill("#invite", code);
    await page.fill("#reg-email", email);
    await page.click("#register-form button[type=submit]");
    await expect(page.locator("#sent")).toBeVisible();

    const link = await getLastMagicLink(request);

    // First use: signs in.
    await page.goto(link);
    await page.waitForURL("**/app.html**", { timeout: 10000 });

    // Clear the session cookie so the second use stands on its own.
    await page.context().clearCookies();

    // Second use of the SAME link: rejected -> back to "/" with ?error=link.
    await page.goto(link);
    await page.waitForURL((url) => url.pathname === "/" && url.search.includes("error=link"), {
      timeout: 10000,
    });
    const u = new URL(page.url());
    expect(u.pathname).toBe("/");
    expect(u.searchParams.get("error")).toBe("link");
  });
});
