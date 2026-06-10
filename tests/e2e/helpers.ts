// tests/e2e/helpers.ts — shared e2e plumbing: seed invite codes straight into
// the dedicated test DB, and a sign-in helper (register -> read captured magic
// link via the /__test seam -> navigate the link -> land signed-in on /app.html).
import { Pool } from "pg";
import type { Page, APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { generateInviteCode, hashInvite } from "../../src/portal/invites.js";

const POSTGRES_URL = "postgres://localhost/notion_mcp_e2e";

// Deterministic, collision-free per-run emails (DB is recreated each run).
let emailCounter = 0;
export function uniqueEmail(tag = "e2e"): string {
  emailCounter += 1;
  return `${tag}-${emailCounter}@example.com`;
}

/** Insert a fresh, unused invite (hash only) into the test DB. Returns the
 *  plaintext code to type into the form. */
export async function seedInvite(label = "e2e"): Promise<string> {
  const code = generateInviteCode();
  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    await pool.query(
      `INSERT INTO invite_codes (code_hash, label) VALUES ($1, $2)
       ON CONFLICT (code_hash) DO NOTHING`,
      [hashInvite(code), label],
    );
  } finally {
    await pool.end();
  }
  return code;
}

/** Read the last captured magic link from the in-process dev-email seam. */
export async function getLastMagicLink(request: APIRequestContext): Promise<string> {
  const res = await request.get("/__test/last-email");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(typeof body.link, `expected a captured magic link, got ${JSON.stringify(body)}`).toBe(
    "string",
  );
  return body.link as string;
}

/** Full register + verify flow: seeds an invite, submits the register form,
 *  follows the captured magic link, and asserts the signed-in dashboard.
 *  Leaves the page on /app.html with the session cookie set. */
export async function registerAndSignIn(
  page: Page,
  request: APIRequestContext,
  email = uniqueEmail(),
): Promise<{ email: string; link: string }> {
  const code = await seedInvite();

  await page.goto("/");
  await page.fill("#invite", code);
  await page.fill("#reg-email", email);
  await page.click("#register-form button[type=submit]");
  // The page swaps to the generic "link sent" confirmation.
  await expect(page.locator("#sent")).toBeVisible();

  const link = await getLastMagicLink(request);
  await page.goto(link);
  await page.waitForURL(/\/app\.html(#.*)?$/, { timeout: 10000 });
  // After design handoff: #who was replaced by #user-email (shows the email directly, no prefix).
  await expect(page.locator("#user-email")).toHaveText(email, { timeout: 10000 });

  return { email, link };
}

/** v2: flip the signed-in account into the "ativado" home state (a connected
 *  source + at least one indexed chunk), which is where the activation
 *  checklist and the live panel render. Adds an iCal link through the real API
 *  (session cookie) and seeds one brain chunk straight into the test DB. */
export async function makeActivated(page: Page): Promise<void> {
  const icalRes = await page.context().request.post("/portal/ical", {
    data: { url: "https://calendar.example.com/e2e/basic.ics", label: "E2E" },
  });
  expect(icalRes.ok()).toBeTruthy();

  const meRes = await page.context().request.get("/portal/me");
  expect(meRes.ok()).toBeTruthy();
  const { account_id: accountId } = await meRes.json();

  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    await pool.query(
      `INSERT INTO brain_chunks (id, account_id, source_type, source_id, chunk_index, text, indexed_at)
       VALUES ($1, $2, 'notion', 'e2e-doc-1', 0, '# Doc e2e\n\nconteúdo de teste', now())
       ON CONFLICT (id) DO NOTHING`,
      [`${accountId}:e2e-doc-1:0`, accountId],
    );
  } finally {
    await pool.end();
  }

  await page.reload();
  await expect(page.locator('body[data-zstate="ativado"]')).toBeAttached({ timeout: 10000 });
}
