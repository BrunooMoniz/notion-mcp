// scripts/admin-preview.ts
// Preview harness for the /admin page WITHOUT Postgres/Stripe: serves
// renderHtml() with a static, representative fixture so UI changes can be
// inspected in a browser and asserted by Playwright (tests/e2e/admin-ui.spec.ts).
//
//   npx tsx scripts/admin-preview.ts            # http://localhost:4799
//   ADMIN_PREVIEW_PORT=5000 npx tsx scripts/admin-preview.ts
//
// Query params: ?msg=...&kind=err render the banner variants.
import http from "node:http";
import { renderHtml, type AdminData } from "../src/admin/routes.js";
import { buildFunnel } from "../src/admin/business.js";

const PORT = Number(process.env.ADMIN_PREVIEW_PORT ?? 4799);

// Render calls checkCostAlert() (fire-and-forget). Neutralize any real alert
// config inherited from the dev's shell so previews/tests never push to ntfy.
process.env.COST_ALERT_USD = "999999";
process.env.NTFY_URL = "";

// Frozen "now" so the rendered page is deterministic.
const NOW = new Date("2026-06-11T12:00:00Z").toISOString();
const MONTH_START = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

// ---------------------------------------------------------------------------
// Account IDs
// ---------------------------------------------------------------------------
const OWNER_ID = "bruno";
// Intentionally long friend id + long email to stress the Contas table layout.
const FRIEND_B_ID = "friend:e09a7c1d-4b2f-48a3-9c5e-1f2a3b4c5d6e";
const FRIEND_B_EMAIL = "fulano.de.tal.workspace.pessoal+zinom@umdominio-bem-comprido-exemplo.com.br";
const FRIEND_C_ID = "friend:c3d4e5f6-7a8b-49c0-bd1e-2f3a4b5c6d7e";

// Two realistic ~160-char indexing error messages.
const ERR_GRANOLA =
  "granola fetch failed: HTTP 502 Bad Gateway from https://api.granola.ai/v2/meetings?cursor=eyJvZmZzZXQiOjEyMH0 after 3 retries; upstream proxy timed out reading body";
const ERR_CALENDAR =
  "ical parse error: invalid VEVENT at line 482 of https://calendar.google.com/calendar/ical/private-abc123/basic.ics — DTSTART missing TZID and value is not UTC zulu";

// ---------------------------------------------------------------------------
// FIXTURE — same shape as gather() in src/admin/routes.ts (AdminData).
// Friend B comes FIRST so the first Contas row exercises the long-content case.
// ---------------------------------------------------------------------------
const FIXTURE: AdminData = {
  accounts: [
    {
      id: FRIEND_B_ID,
      kind: "friend",
      email: FRIEND_B_EMAIL,
      status: "active",
      created_at: new Date("2026-04-02T09:15:00Z"),
      plan: "free",
      plan_status: "comp",
      plan_comp: true,
      current_period_end: null,
    },
    {
      id: OWNER_ID,
      kind: "owner",
      email: null,
      status: "active",
      created_at: new Date("2026-04-10T18:00:00Z"),
      plan: null,
      plan_status: null,
      plan_comp: false,
      current_period_end: null,
    },
    {
      id: FRIEND_C_ID,
      kind: "friend",
      email: "suspensa@example.com",
      status: "suspended",
      created_at: new Date("2026-05-20T11:45:00Z"),
      plan: "pro",
      plan_status: "past_due",
      plan_comp: false,
      current_period_end: new Date("2026-06-20T00:00:00Z"),
    },
  ],
  secrets: new Map([
    [OWNER_ID, ["google_oauth", "notion_access"]],
    [FRIEND_B_ID, ["granola", "ical", "notion_access:ws1"]],
    [FRIEND_C_ID, ["notion_access"]],
  ]),
  workspaces: new Map([
    [OWNER_ID, ["personal"]],
    [FRIEND_B_ID, ["Workspace Pessoal do Fulano", "GlobalCripto Operações", "Nora Finance Diretoria"]],
  ]),
  tokens: new Map([
    [OWNER_ID, 1],
    [FRIEND_B_ID, 2],
  ]),
  usage: new Map([
    [
      FRIEND_B_ID,
      [
        { account_id: FRIEND_B_ID, metric: "embed_tokens", total: "1234567" },
        { account_id: FRIEND_B_ID, metric: "search", total: "321" },
        { account_id: FRIEND_B_ID, metric: "llm_input_tokens", total: "98765" },
        { account_id: FRIEND_B_ID, metric: "llm_output_tokens", total: "4321" },
        { account_id: FRIEND_B_ID, metric: "ask", total: "55" },
        { account_id: FRIEND_B_ID, metric: "index_pages", total: "9999" },
      ],
    ],
  ]),
  runs: new Map([
    [
      FRIEND_B_ID,
      [
        { account_id: FRIEND_B_ID, source: "notion", ok: true, ended_at: new Date("2026-06-11T06:00:00Z") },
        { account_id: FRIEND_B_ID, source: "granola", ok: false, ended_at: new Date("2026-06-11T06:05:00Z") },
        { account_id: FRIEND_B_ID, source: "calendar", ok: true, ended_at: new Date("2026-06-11T06:10:00Z") },
      ],
    ],
  ]),
  errors: new Map([
    [
      FRIEND_B_ID,
      [
        { account_id: FRIEND_B_ID, source: "granola", error: ERR_GRANOLA, ended_at: new Date("2026-06-11T06:05:00Z") },
        { account_id: FRIEND_B_ID, source: "calendar", error: ERR_CALENDAR, ended_at: new Date("2026-06-09T06:10:00Z") },
      ],
    ],
  ]),
  monthStart: MONTH_START,
  invites: { total: "10", redeemed: "4" },
  activeSessions: "2",
  leads: [
    {
      id: 1,
      email: "pendente@example.com",
      name: "Pessoa Pendente",
      note: "Quero testar o Zinom com meu Notion pessoal",
      status: "pending",
      requested_at: new Date("2026-06-09T10:00:00Z"),
      invited_at: null,
      dismissed_at: null,
    },
    {
      id: 2,
      email: "convidada@example.com",
      name: "Pessoa Convidada",
      note: null,
      status: "invited",
      requested_at: new Date("2026-06-07T14:20:00Z"),
      invited_at: new Date("2026-06-10T15:30:00Z"),
      dismissed_at: null,
    },
    {
      id: 3,
      email: "dispensado@example.com",
      name: null,
      note: "oi, libera aí",
      status: "pending",
      requested_at: new Date("2026-06-05T08:00:00Z"),
      invited_at: null,
      dismissed_at: new Date("2026-06-08T09:00:00Z"),
    },
  ],
  funnel: buildFunnel([
    { invites_created: 10, invites_redeemed: 4, has_source: 3, has_search: 2, is_paying: 1 },
  ]),
  engagement: [
    {
      account_id: FRIEND_B_ID,
      searches7d: 42,
      searches30d: 321,
      lastSearch: new Date("2026-06-10T22:11:00Z"),
      dormant: false,
    },
    {
      account_id: FRIEND_C_ID,
      searches7d: 0,
      searches30d: 0,
      lastSearch: new Date("2026-05-02T12:00:00Z"),
      dormant: true,
    },
  ],
  stripeSubs: [
    {
      id: "sub_test_0001",
      status: "active",
      amount: 999,
      currency: "brl",
      current_period_end: Math.floor(Date.UTC(2026, 6, 1) / 1000), // 2026-07-01
      customer: "cus_test_0001",
      account_id: FRIEND_B_ID,
    },
  ],
  stripeSource: "db",
  orgCostReport: null,
  topUsefulChunks: [
    {
      id: "chunk-1111aaaa-bbbb-cccc-dddd-eeeeffff0000",
      account_id: FRIEND_B_ID,
      utility_score: 4.5,
      feedback_count: 7,
      source_type: "notion",
      parent_url: "https://www.notion.so/exemplo/Decisoes-de-Billing-abc123",
      text_snippet: "Decisão: migrar o billing para Stripe hospedado em produção, mantendo a matriz de 4 planos travada (Free convite-only + 3 pagos em BRL).",
    },
    {
      id: "chunk-2222aaaa-bbbb-cccc-dddd-eeeeffff0000",
      account_id: OWNER_ID,
      utility_score: 3.1,
      feedback_count: 4,
      source_type: "granola",
      parent_url: null,
      text_snippet: "Reunião com parceiros: fechamos o roadmap dos 6 objetivos do segundo cérebro por tiers, com memória como quinto source_type.",
    },
  ],
  feedbackPct: 12,
  staleCount: 3,
  chatUsage: [
    {
      account_id: FRIEND_B_ID,
      asks7d: 9,
      asks30d: 55,
      last_ask: new Date("2026-06-11T08:30:00Z"),
    },
  ],
  storageRows: [
    { account_id: OWNER_ID, chunk_count: 45210, approx_bytes: 52428800 },
    { account_id: FRIEND_B_ID, chunk_count: 12345, approx_bytes: 7340032 },
  ],
  wsNames: new Map([[FRIEND_B_ID, "Workspace Pessoal do Fulano"]]),
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const msg = url.searchParams.get("msg") ?? "";
  const kind: "err" | "" = url.searchParams.get("kind") === "err" ? "err" : "";
  try {
    const html = renderHtml(FIXTURE, NOW, "test-token", msg, kind);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err: any) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`renderHtml falhou: ${err?.stack ?? err?.message ?? String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(`admin preview em http://localhost:${PORT}`);
});
