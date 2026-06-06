import { defineConfig, devices } from "@playwright/test";

// E2E config for the Friend Account Portal (001-account-portal).
// Runs the light dev server (src/portal/dev-server.ts) on a DEDICATED port and a
// DEDICATED Postgres DB (notion_mcp_e2e), recreated fresh on every run so tests
// never touch dev data. PORTAL_TEST_MODE=1 exposes the /__test/last-email seam.
const E2E_DB = "notion_mcp_e2e";
const PORT = 3470;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command:
      `dropdb --if-exists ${E2E_DB}; createdb ${E2E_DB}; ` +
      `psql -d ${E2E_DB} -f scripts/portal-dev-schema.sql >/dev/null; ` +
      `PORTAL_PORT=${PORT} PORTAL_EMAIL_DEV=1 PORTAL_TEST_MODE=1 ` +
      `PORTAL_BASE_URL=${BASE_URL} SECRETS_KEY=${"0".repeat(64)} ` +
      `POSTGRES_URL=postgres://localhost/${E2E_DB} npm run dev:portal`,
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    },
  },
});
