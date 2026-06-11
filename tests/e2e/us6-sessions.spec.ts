// tests/e2e/us6-sessions.spec.ts — "Sessões ativas" (Conta): listar e encerrar.
// Reproduz o report do usuário: clicar "encerrar" numa sessão remota deve
// removê-la da lista E do banco.
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { registerAndSignIn } from "./helpers.js";
import { generateSessionId, hashSession } from "../../src/portal/session.js";

const POSTGRES_URL = "postgres://localhost/notion_mcp_e2e";

test("encerrar uma sessão remota remove da lista e do banco", async ({ page, request }) => {
  await registerAndSignIn(page, request);

  const meRes = await page.context().request.get("/portal/me");
  expect(meRes.ok()).toBeTruthy();
  const { account_id: accountId } = await meRes.json();

  // Seed: uma segunda sessão (outro "dispositivo") direto no banco de teste.
  const seedPool = new Pool({ connectionString: POSTGRES_URL });
  try {
    await seedPool.query(
      `INSERT INTO portal_sessions (session_hash, account_id, expires_at, last_seen_at, user_agent)
       VALUES ($1, $2, now() + interval '27 days', now() - interval '3 days', $3)`,
      [hashSession(generateSessionId()), accountId, "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0"],
    );
  } finally {
    await seedPool.end();
  }

  // Recarrega (loadSessions roda no boot), navega até Conta e espera as 2 sessões.
  await page.reload();
  await page.click('[data-nav="conta"]');
  await expect(page.locator("#sessions-list .kv-row")).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator("#sessions-list")).toContainText("Este navegador");

  // Clica "encerrar" na sessão remota.
  await page.click('#sessions-list [data-rm-session]');

  // A lista recarrega sem a sessão remota.
  await expect(page.locator("#sessions-list .kv-row")).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#sessions-list [data-rm-session]')).toHaveCount(0);

  // E o banco só tem a sessão atual.
  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM portal_sessions WHERE account_id=$1`,
      [accountId],
    );
    expect(rows[0].n).toBe(1);
  } finally {
    await pool.end();
  }
});
