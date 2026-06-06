// src/portal/dev-server.ts
// DEV ONLY — run the portal locally without booting the full MCP/brain stack
// (clients.ts requires real Notion tokens; the brain needs pgvector). This mounts
// just the portal API + the static front against a plain local Postgres, so you
// can exercise the invite -> magic link -> sign-in -> credentials flow.
//
//   npm run dev:portal
//
// Needs: POSTGRES_URL (a local DB with scripts/portal-dev-schema.sql applied) and
// SECRETS_KEY. Email defaults to DEV mode (no send) unless RESEND_API_KEY is set
// and PORTAL_EMAIL_DEV is not "1" — in DEV mode the magic link is logged to the
// console so you can copy it into the browser.
import "dotenv/config";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPortalRouter } from "./routes.js";
import { __getLastEmail } from "./email.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_STATIC = join(__dirname, "../../portal");

const app = express();
app.set("trust proxy", "loopback");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, _res, next) => {
  console.log(`[portal-dev] ${req.method} ${req.path}`);
  next();
});

app.use(createPortalRouter());
app.get("/health", (_req, res) => res.json({ status: "ok" }));
// Test-only seam (e2e): expose the last captured magic link to a separate
// Playwright process. No-op unless PORTAL_TEST_MODE=1.
if (process.env.PORTAL_TEST_MODE === "1") {
  app.get("/__test/last-email", (_req, res) => res.json(__getLastEmail() ?? {}));
}
app.use(express.static(PORTAL_STATIC));

const PORT = process.env.PORTAL_PORT ?? process.env.PORT ?? 3456;
app.listen(PORT, () => {
  console.log(`portal dev server on http://localhost:${PORT}`);
  console.log(`  static front: ${PORTAL_STATIC}`);
  console.log(`  email mode: ${process.env.PORTAL_EMAIL_DEV === "1" || !process.env.RESEND_API_KEY ? "DEV (link logged, no send)" : "Resend (real send)"}`);
});
