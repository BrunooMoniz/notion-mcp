// src/admin/routes.ts
// 001-account-portal — operator admin dashboard. Read-only view of accounts,
// their connected sources, MCP tokens, last index runs, usage metering, and
// invite stats. Gated by the operator BEARER_TOKEN (header OR ?token=, same as
// /status) so only Bruno can see it. Server-rendered HTML (no client JS, no
// separate API surface), so the secret never lands in page JS.
import express from "express";
import { getPool } from "../rag/storage.js";
import { escapeHtml } from "../rag/status.js";
import { safeEqual } from "../crypto-utils.js";
import { generateInviteCode, issueInvite, hashInvite } from "../portal/invites.js";
import { sendInviteEmail } from "../portal/email.js";
import { listInviteRequests, markRequestInvited, dismissInviteRequest, type InviteRequest } from "../portal/leads.js";
import { blockAccount, unblockAccount } from "./block.js";
import { monthStartUTC, checkCostAlert } from "../billing/usage.js";
import { getPlanLimits } from "../billing/plans.js";
import { creditsFor } from "../billing/credits.js";
import { ACTIVE_STATUS } from "../account-status.js";
import {
  buildFunnel,
  estimateCost,
  estimateLlmCost,
  summariseCostReport,
  engagementOf,
  mrrFromSubscriptions,
  computeFeedbackPct,
  accountDisplay,
  formatBytes,
  type FunnelRow,
  type EngagementRow,
  type StripeSub,
  type CostReportResponse,
  type TopUsefulChunkRow,
  type ChatUsageRow,
  type StorageRow,
  type AccountDisplayResult,
} from "./business.js";
import { getStripe } from "../billing/stripe.js";
import { getOrgCostReport } from "./anthropic-cost.js";

interface AccountRow {
  id: string;
  kind: string | null;
  email: string | null;
  status: string | null;
  created_at: Date;
  plan: string | null;
  plan_status: string | null;
  current_period_end: Date | null;
}

// In-memory cache for Stripe subscription data (60s TTL).
interface StripeCache {
  subs: StripeSub[];
  fetchedAt: number; // Date.now()
  source: "stripe" | "db";
}
let stripeCache: StripeCache | null = null;
const STRIPE_CACHE_TTL_MS = 60_000;

async function fetchStripeSubs(
  pool: ReturnType<typeof getPool>,
  now: number,
): Promise<{ subs: StripeSub[]; source: "stripe" | "db" }> {
  // Return cached result if fresh.
  if (stripeCache && now - stripeCache.fetchedAt < STRIPE_CACHE_TTL_MS) {
    return { subs: stripeCache.subs, source: stripeCache.source };
  }

  // Try live Stripe API.
  try {
    const stripe = getStripe();
    const list = await stripe.subscriptions.list({ limit: 100, expand: ["data.items.data.price"] });
    const subs: StripeSub[] = list.data.map((sub) => {
      const item = sub.items.data[0];
      const price = item?.price;
      return {
        id: sub.id,
        status: sub.status,
        amount: price?.unit_amount ?? 0,
        currency: price?.currency ?? "brl",
        current_period_end: item?.current_period_end ?? 0,
        customer: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        account_id: (sub.metadata as Record<string, string>)?.account_id ?? null,
      };
    });
    stripeCache = { subs, fetchedAt: now, source: "stripe" };
    return { subs, source: "stripe" };
  } catch (_err) {
    // Fallback: derive from DB account rows.
    const res = await pool.query<{
      id: string;
      stripe_subscription_id: string | null;
      stripe_customer_id: string | null;
      plan: string | null;
      plan_status: string | null;
      current_period_end: Date | null;
    }>(`SELECT id, stripe_subscription_id, stripe_customer_id, plan, plan_status, current_period_end FROM account WHERE stripe_subscription_id IS NOT NULL`);
    const subs: StripeSub[] = res.rows.map((r) => ({
      id: r.stripe_subscription_id ?? "",
      status: r.plan_status ?? "unknown",
      amount: getPlanLimits(r.plan).priceBRLCents,
      currency: "brl",
      current_period_end: r.current_period_end ? Math.floor(r.current_period_end.getTime() / 1000) : 0,
      customer: r.stripe_customer_id ?? "",
      account_id: r.id,
    }));
    stripeCache = { subs, fetchedAt: now, source: "db" };
    return { subs, source: "db" };
  }
}

async function gather() {
  const p = getPool();
  const monthStart = monthStartUTC();
  const [accounts, secrets, workspaces, tokens, usage, runs, errors, invites, sessions, funnelRows, allSearchRows] = await Promise.all([
    p.query<AccountRow>(`SELECT id, kind, email, status, created_at, plan, plan_status, current_period_end FROM account ORDER BY created_at`),
    p.query<{ account_id: string; kinds: string[] }>(
      `SELECT account_id, array_agg(kind ORDER BY kind) AS kinds FROM account_secrets GROUP BY account_id`),
    p.query<{ account_id: string; ws: string[] }>(
      `SELECT account_id, array_agg(workspace ORDER BY workspace) AS ws FROM account_workspaces GROUP BY account_id`),
    p.query<{ account_id: string; n: string }>(
      `SELECT account_id, count(*)::text AS n FROM account_api_tokens GROUP BY account_id`),
    // Usage windowed to the current calendar month (UTC), mirroring how
    // billing/usage.ts meters monthly quotas — not an all-time sum that never
    // resets and so misrepresents what counts against the plan.
    p.query<{ account_id: string; metric: string; total: string }>(
      `SELECT account_id, metric, sum(qty)::text AS total FROM usage_log
       WHERE ts >= $1 GROUP BY account_id, metric`, [monthStart]),
    p.query<{ account_id: string; source: string; ok: boolean; ended_at: Date }>(
      `SELECT DISTINCT ON (account_id, source) account_id, source, ok, ended_at
       FROM status_runs ORDER BY account_id, source, ended_at DESC`),
    // Latest FAILED run per (account, source) with its error text, so the admin
    // sees WHY a source is red, not just that it is. Independent of the latest-run
    // query above (a source can be green now but have a recent failure logged).
    p.query<{ account_id: string; source: string; error: string | null; ended_at: Date }>(
      `SELECT DISTINCT ON (account_id, source) account_id, source, error, ended_at
       FROM status_runs WHERE ok = false ORDER BY account_id, source, ended_at DESC`),
    p.query<{ total: string; redeemed: string }>(
      `SELECT count(*)::text AS total, count(redeemed_at)::text AS redeemed FROM invite_codes`),
    p.query<{ n: string }>(`SELECT count(*)::text AS n FROM portal_sessions WHERE expires_at > now()`),
    // Funnel: counts over 30d window + total (we compute both; use total for the funnel table)
    p.query<FunnelRow>(`
      SELECT
        (SELECT count(*)::int FROM invite_codes) AS invites_created,
        (SELECT count(*)::int FROM invite_codes WHERE redeemed_at IS NOT NULL) AS invites_redeemed,
        (SELECT count(DISTINCT account_id)::int FROM account_secrets) AS has_source,
        (SELECT count(DISTINCT account_id)::int FROM usage_log WHERE metric = 'search') AS has_search,
        (SELECT count(*)::int FROM account WHERE plan != 'free' AND plan_status = 'active') AS is_paying
    `),
    // All search events (last 30d) for engagement computation
    p.query<EngagementRow>(`
      SELECT account_id, ts, metric FROM usage_log
      WHERE metric = 'search' AND ts >= now() - interval '30 days'
      ORDER BY ts DESC
    `),
  ]);
  const leads = await listInviteRequests().catch(() => [] as InviteRequest[]);

  // Chat usage: metric='ask' per account (7d and 30d).
  // Graceful: returns [] when no 'ask' rows exist yet.
  const chatUsageRaw = await p.query<{ account_id: string; asks_7d: string; asks_30d: string; last_ask: Date | null }>(`
    SELECT account_id,
           sum(CASE WHEN ts >= now() - interval '7 days'  THEN qty ELSE 0 END)::text AS asks_7d,
           sum(CASE WHEN ts >= now() - interval '30 days' THEN qty ELSE 0 END)::text AS asks_30d,
           max(ts) AS last_ask
    FROM usage_log
    WHERE metric = 'ask'
    GROUP BY account_id
  `).catch(() => ({ rows: [] as any[] }));

  // Storage: chunk count and approx byte size per account.
  const storageRaw = await p.query<{ account_id: string; chunk_count: string; approx_bytes: string }>(`
    SELECT account_id,
           count(*)::text AS chunk_count,
           coalesce(sum(pg_column_size(embedding) + pg_column_size(text) + pg_column_size(metadata)), 0)::text AS approx_bytes
    FROM brain_chunks
    GROUP BY account_id
  `).catch(() => ({ rows: [] as any[] }));

  // Map account_id -> workspace display name (for accountDisplay helper).
  // account_workspaces.name was added by migration 0010 (nullable; NULL until re-auth).
  const wsNamesRaw = await p.query<{ account_id: string; name: string | null }>(
    `SELECT account_id, name FROM account_workspaces WHERE name IS NOT NULL`
  ).catch(() => ({ rows: [] as any[] }));
  // One account can have multiple workspace rows; use the first non-null name.
  const wsNames = new Map<string, string>();
  for (const r of wsNamesRaw.rows) {
    if (!wsNames.has(r.account_id) && r.name) wsNames.set(r.account_id, r.name);
  }

  const chatUsage: ChatUsageRow[] = chatUsageRaw.rows.map((r: any) => ({
    account_id: r.account_id,
    asks7d: Number(r.asks_7d ?? 0),
    asks30d: Number(r.asks_30d ?? 0),
    last_ask: r.last_ask ? new Date(r.last_ask) : null,
  }));

  const storageRows: StorageRow[] = storageRaw.rows.map((r: any) => ({
    account_id: r.account_id,
    chunk_count: Number(r.chunk_count ?? 0),
    approx_bytes: Number(r.approx_bytes ?? 0),
  }));

  const { subs, source: stripeSource } = await fetchStripeSubs(p, Date.now());

  // Spec 004: memory quality data (graceful: empty on missing tables/migration).
  const [topUsefulChunks, feedbackStats, staleCount] = await Promise.all([
    p.query<TopUsefulChunkRow>(`
      SELECT id, account_id, utility_score, feedback_count, source_type, parent_url,
             left(text, 120) AS text_snippet
      FROM brain_chunks
      WHERE utility_score > 0
      ORDER BY utility_score DESC
      LIMIT 10
    `).then((r) => r.rows).catch(() => [] as TopUsefulChunkRow[]),
    p.query<{ feedback_chunks: string; total_searches: string }>(`
      SELECT
        (SELECT count(DISTINCT chunk_id)::text FROM chunk_feedback) AS feedback_chunks,
        (SELECT coalesce(sum(qty), 0)::text FROM usage_log WHERE metric = 'search') AS total_searches
    `).then((r) => r.rows[0]).catch(() => ({ feedback_chunks: "0", total_searches: "0" })),
    p.query<{ n: string }>(`SELECT count(*)::text AS n FROM stale_memories`)
      .then((r) => Number(r.rows[0]?.n ?? 0)).catch(() => 0),
  ]);

  // F2: Anthropic org-level cost report (cached 1h; null when ANTHROPIC_ADMIN_KEY absent).
  const orgCostReport: CostReportResponse | null = await getOrgCostReport().catch(() => null);

  const byAcct = <T extends { account_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const arr = m.get(r.account_id) ?? [];
      arr.push(r);
      m.set(r.account_id, arr);
    }
    return m;
  };
  const feedbackPct = computeFeedbackPct(
    Number(feedbackStats?.feedback_chunks ?? 0),
    Number(feedbackStats?.total_searches ?? 0),
  );

  return {
    accounts: accounts.rows,
    secrets: new Map(secrets.rows.map((r) => [r.account_id, r.kinds])),
    workspaces: new Map(workspaces.rows.map((r) => [r.account_id, r.ws])),
    tokens: new Map(tokens.rows.map((r) => [r.account_id, Number(r.n)])),
    usage: byAcct(usage.rows),
    runs: byAcct(runs.rows),
    errors: byAcct(errors.rows),
    monthStart,
    invites: invites.rows[0] ?? { total: "0", redeemed: "0" },
    activeSessions: sessions.rows[0]?.n ?? "0",
    leads,
    funnel: buildFunnel(funnelRows.rows),
    engagement: engagementOf(allSearchRows.rows, new Date()),
    stripeSubs: subs,
    stripeSource,
    orgCostReport,
    // Spec 004: memory quality
    topUsefulChunks,
    feedbackPct,
    staleCount,
    // Admin v2: new sections
    chatUsage,
    storageRows,
    wsNames,
  };
}

function sourceFlags(kinds: string[] | undefined): string {
  if (!kinds) return "—";
  const has = (prefix: string) => kinds.some((k) => k === prefix || k.startsWith(prefix + ":"));
  const tags: string[] = [];
  if (has("notion_access") || has("notion_pat")) tags.push("Notion");
  if (kinds.includes("granola")) tags.push("Granola");
  if (kinds.includes("ical")) tags.push("iCal");
  if (kinds.includes("google_oauth")) tags.push("Google");
  return tags.length ? tags.join(", ") : "—";
}

function renderFunnelSection(data: Awaited<ReturnType<typeof gather>>): string {
  const steps = data.funnel;
  const bars = steps
    .map(
      (s) => `
    <div class="funnel-step">
      <div class="funnel-label">
        <span class="funnel-name">${escapeHtml(s.label)}</span>
        <span class="funnel-count">${s.count} <span class="funnel-pct">(${s.pct}%)</span></span>
      </div>
      <div class="funnel-track">
        <div class="funnel-bar" style="width:${s.pct}%"></div>
      </div>
    </div>`,
    )
    .join("");
  return `<section class="section" id="funil">
  <div class="section-header">
    <h2 class="section-title">Funil de ativação</h2>
    <p class="section-desc">De todos os convites criados, quantos viraram contas, conectaram uma fonte, fizeram a primeira busca e pagam hoje. Quedas grandes entre etapas mostram onde os usuários travam.</p>
  </div>
  <div class="funnel-wrap">${bars}</div>
</section>`;
}

function renderStripeSection(data: Awaited<ReturnType<typeof gather>>): string {
  const { mrrCents, byStatus } = mrrFromSubscriptions(data.stripeSubs);
  const sourceLabel = data.stripeSource === "stripe" ? "Stripe API" : "DB (fallback)";
  const mrrFmt = formatBRL(mrrCents);
  const subRows = data.stripeSubs
    .map((s) => {
      const renewsAt = s.current_period_end
        ? new Date(s.current_period_end * 1000).toISOString().slice(0, 10)
        : "—";
      const amtFmt = formatBRL(s.amount);
      // accountDisplay needs a full AccountDisplayRow; Stripe subs only have account_id.
      // For subs without account_id, show the Stripe customer ID as fallback.
      const acctId = s.account_id ?? s.customer;
      // Look up the account in data.accounts to get email + kind.
      const acctRow = data.accounts.find((a) => a.id === acctId);
      const disp: AccountDisplayResult = acctRow
        ? accountDisplay(acctRow, data.wsNames)
        : { primary: acctId, secondary: acctId };
      return `<tr>
        <td>
          <span class="acct-primary">${escapeHtml(disp.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(disp.secondary)}</span>
        </td>
        <td class="xs">${amtFmt}</td>
        <td><span class="tag ${s.status === "active" ? "ok" : s.status === "canceled" ? "bad" : ""}">${escapeHtml(s.status)}</span></td>
        <td class="xs">${escapeHtml(renewsAt)}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="section" id="receita">
  <div class="section-header">
    <h2 class="section-title">Receita real <span class="tag" style="margin-left:6px;vertical-align:middle">fonte: ${escapeHtml(sourceLabel)}</span></h2>
    <p class="section-desc">Dados ao vivo do Stripe (cache 60 s). MRR soma apenas assinaturas ativas. Assinaturas <em>past_due</em> ainda cobram; <em>canceled</em> não entram no MRR.</p>
  </div>
  <div class="cards">
    <div class="card" title="Receita Mensal Recorrente: soma do valor das assinaturas ativas no Stripe">
      <div class="card-n">${mrrFmt}</div>
      <div class="card-l">MRR real</div>
      <small class="card-hint">somente assinaturas ativas</small>
    </div>
    <div class="card" title="Assinaturas com status 'active' no Stripe">
      <div class="card-n">${byStatus.active ?? 0}</div>
      <div class="card-l">Ativas</div>
      <small class="card-hint">cobradas normalmente</small>
    </div>
    <div class="card" title="Assinaturas com pagamento pendente (past_due)">
      <div class="card-n">${byStatus.past_due ?? 0}</div>
      <div class="card-l">Inadimplentes</div>
      <small class="card-hint">pagamento em atraso</small>
    </div>
    <div class="card" title="Assinaturas canceladas — não contam no MRR">
      <div class="card-n">${byStatus.canceled ?? 0}</div>
      <div class="card-l">Canceladas</div>
      <small class="card-hint">fora do MRR</small>
    </div>
  </div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="ID da conta Zinom ou customer ID do Stripe">conta / customer</th>
      <th title="Valor mensal da assinatura em BRL">valor/mês</th>
      <th title="Status atual no Stripe">status</th>
      <th title="Data de renovação do ciclo atual">renova em</th>
    </tr></thead>
    <tbody>
${subRows || '<tr><td colspan="4" class="xs muted">Nenhuma subscription encontrada.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderEngagementSection(data: Awaited<ReturnType<typeof gather>>): string {
  const engMap = new Map(data.engagement.map((e) => [e.account_id, e]));
  // Top 5 by searches30d
  const top5 = [...data.engagement].sort((a, b) => b.searches30d - a.searches30d).slice(0, 5);
  const top5Html = top5.length
    ? top5
        .map(
          (e) =>
            `<li class="top-item"><span class="mono xs">${escapeHtml(e.account_id)}</span><span class="top-count">${e.searches30d} buscas</span></li>`,
        )
        .join("")
    : '<li class="top-item muted">Nenhuma busca registrada.</li>';

  const rows = data.accounts
    .map((a) => {
      const eng = engMap.get(a.id);
      const s7 = eng?.searches7d ?? 0;
      const s30 = eng?.searches30d ?? 0;
      const last = eng?.lastSearch ? eng.lastSearch.toISOString().slice(0, 10) : "—";
      const dormantTag = eng?.dormant
        ? '<span class="tag bad">dormente</span>'
        : eng && eng.searches30d > 0
          ? '<span class="tag ok">ativo</span>'
          : '<span class="tag">inativo</span>';
      const dispE = accountDisplay(a, data.wsNames);
      return `<tr>
        <td>
          <span class="acct-primary">${escapeHtml(dispE.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(dispE.secondary)}</span>
        </td>
        <td class="xs">${s7}</td>
        <td class="xs">${s30}</td>
        <td class="xs">${escapeHtml(last)}</td>
        <td>${dormantTag}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="section" id="engajamento">
  <div class="section-header">
    <h2 class="section-title">Uso e engajamento</h2>
    <p class="section-desc">Dormente = já usou, mas está sem buscar há 14+ dias: risco de churn. Ativo = buscou nos últimos 30 dias. Inativo = nunca buscou ou sem dados no período.</p>
  </div>
  <div class="top5">
    <p class="top5-label">Top 5 do mês (por buscas nos últimos 30 dias)</p>
    <ol class="top5-list">${top5Html}</ol>
  </div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="Identificador único da conta no Zinom">conta</th>
      <th title="Número de buscas realizadas nos últimos 7 dias">buscas 7d</th>
      <th title="Número de buscas realizadas nos últimos 30 dias">buscas 30d</th>
      <th title="Data da última busca registrada pelo usuário">última busca</th>
      <th title="Ativo = buscou nos últimos 30d; Dormente = buscou antes, mas parou há 14d+">estado</th>
    </tr></thead>
    <tbody>
${rows || '<tr><td colspan="5" class="xs muted">Nenhuma conta.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderCostSection(data: Awaited<ReturnType<typeof gather>>): string {
  const costEnv: import("./business.js").CostEnv = {
    COST_EMBED_PER_MTOK: process.env.COST_EMBED_PER_MTOK,
    COST_PER_SEARCH: process.env.COST_PER_SEARCH,
  };
  const llmCostEnv: import("./business.js").LlmCostEnv = {
    COST_LLM_IN_PER_MTOK: process.env.COST_LLM_IN_PER_MTOK,
    COST_LLM_OUT_PER_MTOK: process.env.COST_LLM_OUT_PER_MTOK,
  };
  const hasCostConfig = costEnv.COST_EMBED_PER_MTOK !== undefined && costEnv.COST_PER_SEARCH !== undefined;
  const warning = hasCostConfig ? "" : `<div class="alert">Configure <code>COST_EMBED_PER_MTOK</code> e <code>COST_PER_SEARCH</code> no <code>.env</code> para habilitar estimativas de custo.</div>`;

  // F2: org-level Anthropic cost card (hidden when key absent).
  const orgCostCard = (() => {
    if (!data.orgCostReport) return "";
    const summary = summariseCostReport(data.orgCostReport);
    // amount is in cents (lowest currency units), divide by 100 for dollars.
    const totalUsd = (summary.totalUsdCents / 100).toFixed(2);
    return `<div class="card" title="Custo real total da organização na Anthropic no mês corrente (dados ao vivo, cache 1h)">
      <div class="card-n">$${escapeHtml(totalUsd)}</div>
      <div class="card-l">Custo real Anthropic (org, mês)</div>
      <small class="card-hint">custo real da organização inteira na Anthropic; o rateio por conta é estimado</small>
    </div>`;
  })();

  const rows = data.accounts
    .map((a) => {
      const usageRows = data.usage.get(a.id) ?? [];
      const embedTokens = Number(usageRows.find((u) => u.metric === "embed_tokens")?.total ?? 0);
      const searches = Number(usageRows.find((u) => u.metric === "search")?.total ?? 0);
      const llmInputTokens = Number(usageRows.find((u) => u.metric === "llm_input_tokens")?.total ?? 0);
      const llmOutputTokens = Number(usageRows.find((u) => u.metric === "llm_output_tokens")?.total ?? 0);
      const cost = estimateCost({ embed_tokens: embedTokens, searches }, costEnv);
      const llmCost = estimateLlmCost({ llm_input_tokens: llmInputTokens, llm_output_tokens: llmOutputTokens }, llmCostEnv);
      // F7: cost alert guard-rail — fire best-effort notify when LLM cost exceeds threshold.
      if (llmCost.totalCost > 0) {
        checkCostAlert(a.id, llmCost.totalCost).catch(() => {/* swallowed */});
      }
      const planPrice = getPlanLimits(a.plan).priceBRLCents / 100;
      const margin = hasCostConfig ? planPrice - cost.totalCost : null;
      const fmtCost = hasCostConfig ? `$${cost.totalCost.toFixed(4)}` : "—";
      const fmtMargin = margin !== null ? `R$${margin.toFixed(2)}` : "—";
      const fmtLlmIn = llmInputTokens > 0 ? llmInputTokens.toLocaleString("pt-BR") : "—";
      const fmtLlmOut = llmOutputTokens > 0 ? llmOutputTokens.toLocaleString("pt-BR") : "—";
      const fmtLlmCost = llmCost.totalCost > 0 ? `$${llmCost.totalCost.toFixed(4)}` : "—";
      const dispC = accountDisplay(a, data.wsNames);
      return `<tr>
        <td>
          <span class="acct-primary">${escapeHtml(dispC.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(dispC.secondary)}</span>
        </td>
        <td class="xs">${escapeHtml(a.plan ?? "free")}</td>
        <td class="xs">${embedTokens.toLocaleString("pt-BR")}</td>
        <td class="xs">${searches}</td>
        <td class="xs">${fmtLlmIn}</td>
        <td class="xs">${fmtLlmOut}</td>
        <td class="xs">${fmtLlmCost}</td>
        <td class="xs">${fmtCost}</td>
        <td class="xs">${fmtMargin}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="section" id="custo">
  <div class="section-header">
    <h2 class="section-title">Custo estimado por conta <span class="tag" style="margin-left:6px;vertical-align:middle">estimativa</span></h2>
    <p class="section-desc">Estimativa de custo de infraestrutura de IA por conta no mês (embeddings + buscas + LLM). Tokens LLM 30d = soma de llm_input_tokens e llm_output_tokens no mês corrente. Custo LLM estimado usa preços Claude Haiku 4.5 por padrão (configurável via <code>COST_LLM_IN_PER_MTOK</code> / <code>COST_LLM_OUT_PER_MTOK</code>). Margem = preço do plano &minus; custo embed+busca estimado.</p>
  </div>
  ${orgCostCard ? `<div class="cards" style="margin-bottom:20px">${orgCostCard}</div>` : ""}
  ${warning}
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="Identificador único da conta no Zinom">conta</th>
      <th title="Plano de assinatura atual da conta">plano</th>
      <th title="Total de tokens usados em embeddings no mês corrente">embed_tokens</th>
      <th title="Total de buscas realizadas no mês corrente">buscas</th>
      <th title="Tokens LLM de entrada (ask + classifier) no mês corrente">LLM in 30d</th>
      <th title="Tokens LLM de saída (ask + classifier) no mês corrente">LLM out 30d</th>
      <th title="Custo LLM estimado com base nos tokens (Claude Haiku 4.5: $1/MTok in, $5/MTok out)">custo LLM est.</th>
      <th title="Estimativa de custo total em USD com base nos tokens e buscas (embed+busca)">custo infra est.</th>
      <th title="Receita do plano menos custo estimado — positivo é saudável">margem</th>
    </tr></thead>
    <tbody>
${rows || '<tr><td colspan="9" class="xs muted">Nenhuma conta.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>`;
}

/** Format cents as BRL currency string. */
function formatBRL(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

// ---------------------------------------------------------------------------
// Spec 004: Qualidade da memoria section
// ---------------------------------------------------------------------------

function renderMemoryQualitySection(data: Awaited<ReturnType<typeof gather>>): string {
  const topRows = data.topUsefulChunks
    .map((c) => {
      const snippet = escapeHtml((c.text_snippet ?? "").slice(0, 100));
      const url = c.parent_url
        ? `<a href="${escapeHtml(c.parent_url)}" target="_blank" rel="noopener" class="xs">${escapeHtml(c.parent_url.slice(0, 60))}</a>`
        : "—";
      const acctM = data.accounts.find((a) => a.id === c.account_id);
      const dispM = acctM ? accountDisplay(acctM, data.wsNames) : { primary: c.account_id, secondary: c.account_id };
      return `<tr>
        <td class="mono xs">${escapeHtml(c.id.slice(0, 16))}&hellip;</td>
        <td>
          <span class="acct-primary">${escapeHtml(dispM.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(dispM.secondary)}</span>
        </td>
        <td class="xs">${escapeHtml(c.source_type)}</td>
        <td class="xs">${c.utility_score.toFixed(2)}</td>
        <td class="xs">${c.feedback_count}</td>
        <td class="xs trunc">${snippet}</td>
        <td class="xs">${url}</td>
      </tr>`;
    })
    .join("\n");

  return `<section class="section" id="qualidade-memoria">
  <div class="section-header">
    <h2 class="section-title">Qualidade da memoria</h2>
    <p class="section-desc">Ranking de trechos mais uteis, cobertura de feedback e memorias obsoletas. Decay de 0.5%/dia. Stale: eff_utility &lt; -2 OU (mais de 180 dias + utilidade = 0 + nunca citado). Nenhuma exclusao automatica nesta fase.</p>
  </div>
  <div class="cards" style="margin-bottom:20px">
    <div class="card" title="Percentual estimado de buscas que geraram pelo menos um evento de feedback (thumbs ou assistente)">
      <div class="card-n">${data.feedbackPct}%</div>
      <div class="card-l">Buscas com feedback</div>
      <small class="card-hint">sinal explicito ou implicito</small>
    </div>
    <div class="card" title="Trechos na view stale_memories — candidatos a arquivamento manual (sem exclusao automatica)">
      <div class="card-n">${data.staleCount}</div>
      <div class="card-l">Memorias obsoletas</div>
      <small class="card-hint">candidatos a arquivamento</small>
    </div>
  </div>
  <h3 style="font-size:14px;font-weight:600;margin-bottom:10px;color:var(--ink-soft)">Top 10 trechos mais uteis</h3>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="ID do trecho (primeiros 16 chars)">chunk ID</th>
      <th title="Conta proprietaria">conta</th>
      <th title="Tipo de fonte">fonte</th>
      <th title="Pontuacao de utilidade materializada">utilidade</th>
      <th title="Total de eventos de feedback">feedbacks</th>
      <th title="Inicio do texto indexado">texto</th>
      <th title="URL da pagina de origem">URL</th>
    </tr></thead>
    <tbody>
${topRows || '<tr><td colspan="7" class="xs muted">Nenhum trecho com feedback positivo ainda.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderChatSection(data: Awaited<ReturnType<typeof gather>>): string {
  const chatMap = new Map(data.chatUsage.map((c) => [c.account_id, c]));
  const rows = data.accounts
    .map((a) => {
      const disp = accountDisplay(a, data.wsNames);
      const chat = chatMap.get(a.id);
      const asks7d = chat?.asks7d ?? 0;
      const asks30d = chat?.asks30d ?? 0;
      const lastAsk = chat?.last_ask ? chat.last_ask.toISOString().slice(0, 10) : "—";
      return `<tr>
        <td>
          <span class="acct-primary">${escapeHtml(disp.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(disp.secondary)}</span>
        </td>
        <td class="xs">${asks7d}</td>
        <td class="xs">${asks30d}</td>
        <td class="xs">${escapeHtml(lastAsk)}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="section" id="uso-chat">
  <div class="section-header">
    <h2 class="section-title">Uso do chat</h2>
    <p class="section-desc">Mensagens enviadas ao chat interno (métrica <code>ask</code> no usage_log), por conta, nos últimos 7 e 30 dias. Valores zerados indicam que o recurso ainda não foi usado ou que a métrica foi adicionada recentemente.</p>
  </div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="Conta">Conta</th>
      <th title="Mensagens no chat nos últimos 7 dias">asks 7d</th>
      <th title="Mensagens no chat nos últimos 30 dias">asks 30d</th>
      <th title="Data do último uso do chat">último ask</th>
    </tr></thead>
    <tbody>
${rows || '<tr><td colspan="4" class="xs muted">Nenhuma conta.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderStorageSection(data: Awaited<ReturnType<typeof gather>>): string {
  const storMap = new Map(data.storageRows.map((s) => [s.account_id, s]));
  const totalBytes = data.storageRows.reduce((sum, s) => sum + s.approx_bytes, 0);
  const totalChunks = data.storageRows.reduce((sum, s) => sum + s.chunk_count, 0);

  const rows = data.accounts
    .map((a) => {
      const disp = accountDisplay(a, data.wsNames);
      const stor = storMap.get(a.id);
      const chunks = stor?.chunk_count ?? 0;
      const bytes = stor?.approx_bytes ?? 0;
      const pct = totalBytes > 0 ? ((bytes / totalBytes) * 100).toFixed(1) : "0.0";
      return `<tr>
        <td>
          <span class="acct-primary">${escapeHtml(disp.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(disp.secondary)}</span>
        </td>
        <td class="xs">${chunks.toLocaleString("pt-BR")}</td>
        <td class="xs">${escapeHtml(formatBytes(bytes))}</td>
        <td class="xs">${pct}%</td>
      </tr>`;
    })
    .join("\n");

  return `<section class="section" id="armazenamento">
  <div class="section-header">
    <h2 class="section-title">Armazenamento</h2>
    <p class="section-desc">Uso de <code>brain_chunks</code> por conta: número de trechos indexados e tamanho aproximado em disco (soma dos bytes das colunas <code>embedding</code>, <code>text</code> e <code>metadata</code>). Total atual: <strong>${escapeHtml(formatBytes(totalBytes))}</strong> em ${totalChunks.toLocaleString("pt-BR")} trechos. O armazenamento é pequeno — o custo real está nos tokens de embedding e LLM.</p>
  </div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="Conta">Conta</th>
      <th title="Número de trechos indexados">trechos</th>
      <th title="Tamanho aproximado em disco (embedding + text + metadata)">tamanho est.</th>
      <th title="Percentual do total de armazenamento">% do total</th>
    </tr></thead>
    <tbody>
${rows || '<tr><td colspan="4" class="xs muted">Nenhum dado de armazenamento.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderHtml(data: Awaited<ReturnType<typeof gather>>, now: string, token: string, msg: string): string {
  const friends = data.accounts.filter((a) => a.kind === "friend");
  const pending = data.leads.filter((l) => l.status === "pending" && !l.dismissed_at).length;
  // Approx MRR: sum of active paid plans, priced from the plan matrix
  // (billing/plans.ts) so it never drifts from a hardcoded cents map.
  const mrrCents = data.accounts.reduce(
    (sum, a) => sum + (a.plan_status !== "canceled" ? getPlanLimits(a.plan).priceBRLCents : 0),
    0,
  );
  const mrr = formatBRL(mrrCents);
  const action = `/admin/invite?token=${encodeURIComponent(token)}`;
  const blockAction = `/admin/block?token=${encodeURIComponent(token)}`;
  const unblockAction = `/admin/unblock?token=${encodeURIComponent(token)}`;
  const dismissAction = `/admin/lead/dismiss?token=${encodeURIComponent(token)}`;

  const rows = data.accounts
    .map((a) => {
      const usageRows = data.usage.get(a.id) ?? [];
      const usageStr = usageRows.map((u) => `${u.metric}:${u.total}`).join(" · ") || "—";
      // F7: compute credits used from usage rows.
      const creditsUsed = Math.round(usageRows.reduce((sum, u) => sum + creditsFor(u.metric, Number(u.total)), 0));
      const planLimits = getPlanLimits(a.plan);
      const creditsLimit = planLimits.monthly_credits;
      const creditsStr = isFinite(creditsLimit)
        ? `${creditsUsed}/${creditsLimit}`
        : `${creditsUsed}/∞`;
      const creditsOver = isFinite(creditsLimit) && creditsUsed > creditsLimit;
      // Latest failed-run error per source (truncated), shown beneath the ✓/✗ flags
      // so a red source explains itself.
      const errs = (data.errors.get(a.id) ?? [])
        .filter((e) => e.error)
        .map((e) => `${escapeHtml(e.source)}: ${escapeHtml(String(e.error).slice(0, 160))}`);
      const runFlags =
        (data.runs.get(a.id) ?? [])
          .map((r) => `${escapeHtml(r.source)}${r.ok ? "&#10003;" : "&#10007;"}`)
          .join(" ") || "—";
      const runs = runFlags + (errs.length
        ? `<details class="err-details"><summary>${errs.length} erro(s)</summary><div class="err">${errs.join("<br>")}</div></details>`
        : "");
      const ws = data.workspaces.get(a.id);
      const status = a.status ?? ACTIVE_STATUS;
      const suspended = status !== ACTIVE_STATUS;
      const statusCell = suspended
        ? `<span class="tag bad">${escapeHtml(status)}</span>`
        : `<span class="tag ok">${escapeHtml(status)}</span>`;
      // Owner ('bruno') is never blockable from the UI (it has no accountId on the
      // auth path and must always keep access).
      const isOwner = a.kind === "owner";
      const actCell = isOwner
        ? '<span class="muted xs">—</span>'
        : suspended
          ? `<form method="POST" action="${escapeHtml(unblockAction)}" style="margin:0"
                 onsubmit="return confirm('Reativar ${escapeHtml(a.id)}?')">
               <input type="hidden" name="account_id" value="${escapeHtml(a.id)}">
               <button type="submit">Reativar</button>
             </form>`
          : `<form method="POST" action="${escapeHtml(blockAction)}" style="margin:0"
                 onsubmit="return confirm('Bloquear ${escapeHtml(a.id)}? Revoga os tokens MCP.')">
               <input type="hidden" name="account_id" value="${escapeHtml(a.id)}">
               <button type="submit" class="danger">Bloquear</button>
             </form>`;
      const periodEnd = a.current_period_end
        ? new Date(a.current_period_end).toISOString().slice(0, 10)
        : "—";
      const tokenCount = data.tokens.get(a.id);
      const dispA = accountDisplay(a, data.wsNames);
      return `<tr>
        <td>
          <span class="acct-primary">${escapeHtml(dispA.primary)}</span>
          <span class="acct-secondary mono xs muted">${escapeHtml(dispA.secondary)}</span>
        </td>
        <td class="xs">${escapeHtml(a.kind ?? "—")}</td>
        <td>${statusCell}</td>
        <td class="xs">${escapeHtml(a.plan ?? "free")}${a.plan_status && a.plan_status !== "active" ? ` <span class="tag">${escapeHtml(a.plan_status)}</span>` : ""}</td>
        <td class="xs">${escapeHtml(periodEnd)}</td>
        <td class="xs">${escapeHtml(sourceFlags(data.secrets.get(a.id)))}</td>
        <td class="xs">${tokenCount ? `${tokenCount} token(s)` : "—"}</td>
        <td class="xs trunc">${ws ? escapeHtml(ws.join(", ")) : "—"}</td>
        <td class="xs">${runs}</td>
        <td class="xs">${escapeHtml(usageStr)}</td>
        <td class="xs"${creditsOver ? ' style="color:#d64545;font-weight:600"' : ""}>${escapeHtml(creditsStr)}</td>
        <td class="xs">${new Date(a.created_at).toLocaleString("pt-BR")}</td>
        <td>${actCell}</td>
      </tr>`;
    })
    .join("\n");

  const leadRows = data.leads
    .map((l) => {
      let act: string;
      if (l.dismissed_at) {
        act = `<span class="tag bad">dispensado ${new Date(l.dismissed_at).toLocaleString("pt-BR")}</span>`;
      } else if (l.status === "pending") {
        act = `<div style="display:flex;gap:6px;flex-wrap:wrap">
          <form method="POST" action="${escapeHtml(action)}" style="margin:0">
            <input type="hidden" name="email" value="${escapeHtml(l.email)}">
            <button type="submit">Gerar e enviar convite</button>
          </form>
          <form method="POST" action="${escapeHtml(dismissAction)}" style="margin:0"
                onsubmit="return confirm('Dispensar ${escapeHtml(l.email)}? Isso não apaga o lead.')">
            <input type="hidden" name="email" value="${escapeHtml(l.email)}">
            <button type="submit" class="secondary">Dispensar</button>
          </form>
        </div>`;
      } else {
        act = `<span class="tag ok">convidado ${l.invited_at ? new Date(l.invited_at).toLocaleString("pt-BR") : ""}</span>`;
      }
      return `<tr>
        <td class="xs">${escapeHtml(l.email)}</td>
        <td class="xs">${escapeHtml(l.name ?? "—")}</td>
        <td class="xs trunc">${escapeHtml(l.note ?? "—")}</td>
        <td class="xs">${new Date(l.requested_at).toLocaleString("pt-BR")}</td>
        <td>${act}</td>
      </tr>`;
    })
    .join("\n");

  // Banner is now rendered inline in the shell (dismissible via JS).
  // The old `banner` string variable is kept for backward compat but unused.
  const _banner = "";

  const logoSvg = `<svg width="28" height="28" viewBox="0 0 26 26" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="24" height="24" rx="7.5" fill="var(--accent)"/>
    <path d="M8 8 H18 L8 18 H18" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="8" cy="8" r="1.7" fill="#fff"/>
    <circle cx="18" cy="8" r="1.7" fill="#fff"/>
    <circle cx="8" cy="18" r="1.7" fill="#fff"/>
    <circle cx="18" cy="18" r="1.7" fill="#fff"/>
  </svg>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zinom.ai — Admin</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<style>
@import url('https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.2.6/index.css');
@import url('https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.2.6/index.css');
</style>
<style>
/* --- Design tokens (identidade Zinom, tema claro) --- */
:root{
  --bg:#fff;
  --paper:#f7f6f3;
  --paper-2:#f1efe9;
  --ink:#26241f;
  --ink-soft:#4a4740;
  --muted:#827d73;
  --line:#eae7df;
  --line-2:#e0ddd3;
  --accent:#1f8b4c;
  --accent-strong:#15633a;
  --accent-soft:#ecf5ef;
  --r:16px;
  --r-sm:11px;
  --r-xs:8px;
  --shadow-sm:0 1px 2px rgba(38,36,31,.05),0 1px 1px rgba(38,36,31,.04);
  --sans:"Geist Variable",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --mono:"Geist Mono Variable",ui-monospace,"SF Mono",Menlo,monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  font-family:var(--sans);
  font-size:14px;
  line-height:1.55;
  color:var(--ink);
  background:var(--bg);
  margin:0;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-strong)}
h1,h2,h3,p{margin:0}
code{
  font-family:var(--mono);
  font-size:12px;
  background:var(--paper);
  border:1px solid var(--line);
  border-radius:4px;
  padding:1px 5px;
  color:var(--accent-strong);
}

/* --- Shell --- */
.shell{min-height:100vh;display:flex}

/* --- Sidebar (desktop) --- */
.sidebar{
  display:none;
}
@media(min-width:900px){
  .sidebar{
    display:flex;flex-direction:column;
    width:220px;flex:0 0 220px;
    position:fixed;top:0;left:0;height:100vh;z-index:100;
    background:var(--paper);
    border-right:1px solid var(--line);
  }
  .main{
    margin-left:220px;
    flex:1;min-width:0;
    padding:28px 40px 80px;
  }
}

/* --- Sidebar brand --- */
.sidebar-brand{
  display:flex;align-items:center;gap:10px;
  padding:20px 16px 14px;
  font-size:16px;font-weight:650;letter-spacing:-.02em;color:var(--ink);
  text-decoration:none;
}
.sidebar-sub{font-size:11px;font-weight:400;color:var(--muted);font-family:var(--mono);margin-left:auto}
.sidebar-nav{flex:1;padding:4px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.nav-item{
  display:flex;align-items:center;gap:9px;
  padding:8px 10px;
  border-radius:var(--r-xs);
  font-size:13px;font-weight:500;color:var(--ink-soft);
  background:none;border:none;cursor:pointer;text-align:left;width:100%;
  text-decoration:none;
  transition:background .12s,color .12s;
}
.nav-item:hover{background:var(--paper-2);color:var(--ink);text-decoration:none}
.nav-item.active{background:var(--accent-soft);color:var(--accent-strong);font-weight:600}
.sidebar-footer{
  padding:12px 16px 16px;
  border-top:1px solid var(--line);
  font-size:11.5px;color:var(--muted);
}

/* --- Mobile topbar --- */
.mobile-top{
  position:sticky;top:0;z-index:60;
  display:flex;align-items:center;gap:9px;
  padding:11px 16px;
  background:rgba(255,255,255,.92);
  backdrop-filter:blur(8px);
  border-bottom:1px solid var(--line);
}
@media(min-width:900px){.mobile-top{display:none}}
.mobile-top .brand-name{font-weight:650;font-size:16px;letter-spacing:-.02em}
.mobile-top .view-name{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted)}

/* --- Mobile tabbar (collapsed nav) --- */
.tabbar-mobile{
  position:fixed;bottom:0;left:0;right:0;z-index:70;
  display:flex;overflow-x:auto;
  background:rgba(255,255,255,.96);
  backdrop-filter:blur(8px);
  border-top:1px solid var(--line);
  gap:0;
  padding-bottom:env(safe-area-inset-bottom,0);
}
@media(min-width:900px){.tabbar-mobile{display:none}}
.tabbar-mobile a{
  display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:8px 10px 9px;
  min-width:60px;
  font-size:9.5px;font-weight:540;color:var(--muted);
  text-decoration:none;white-space:nowrap;
}
.tabbar-mobile a.active{color:var(--accent-strong)}

/* --- Main content area (mobile default) --- */
.main{
  flex:1;min-width:0;
  padding:0 16px calc(72px + env(safe-area-inset-bottom,0));
}

/* --- Banner (dismissible, sticky) --- */
.banner-fixed{
  position:sticky;top:0;z-index:50;
  background:var(--accent-soft);border-bottom:1px solid rgba(31,139,76,.25);
  color:var(--accent-strong);
  padding:10px 20px;font-size:13px;
  display:flex;align-items:center;gap:12px;
}
.banner-fixed .banner-msg{flex:1}
.banner-close{
  background:none;border:none;cursor:pointer;
  color:var(--accent-strong);font-size:18px;line-height:1;padding:0 4px;
  font-weight:300;
}
.banner-close:hover{color:var(--accent)}
.alert{
  background:#fff8e1;border:1px solid #f9a825;
  color:#5d4037;border-radius:var(--r-xs);
  padding:10px 16px;margin-bottom:16px;font-size:13px;
}

/* --- Summary metric cards --- */
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:0}
.card{
  background:var(--bg);
  border:1px solid var(--line);
  border-radius:var(--r);
  padding:16px 20px;
  min-width:130px;
  box-shadow:var(--shadow-sm);
  transition:box-shadow .15s;
}
.card:hover{box-shadow:0 4px 12px rgba(38,36,31,.1)}
.card-n{font-size:26px;font-weight:700;letter-spacing:-.03em;color:var(--ink)}
.card-l{font-size:12px;font-weight:500;color:var(--ink-soft);margin-top:2px}
.card-hint{display:block;font-size:11px;color:var(--muted);margin-top:4px}

/* --- Sections --- */
.section{padding:36px 0 0}
.section-header{margin-bottom:20px}
.section-title{font-size:17px;font-weight:650;letter-spacing:-.02em;color:var(--ink);margin-bottom:6px}
.section-desc{font-size:13px;color:var(--ink-soft);line-height:1.55;max-width:720px}
.section-desc em{font-style:normal;font-weight:600;color:var(--ink)}

/* --- Tags --- */
.tag{
  display:inline-block;font-size:11.5px;font-weight:500;
  padding:2px 8px;border-radius:999px;
  background:var(--paper);color:var(--ink-soft);
  border:1px solid var(--line);
}
.tag.ok{background:var(--accent-soft);color:var(--accent-strong);border-color:rgba(31,139,76,.2)}
.tag.bad{background:#fdecec;color:#9a2820;border-color:rgba(154,40,32,.2)}

/* --- Table wrapper --- */
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow-sm)}
table{width:100%;border-collapse:collapse;background:var(--bg)}
thead tr{background:var(--paper)}
th{
  text-align:left;padding:10px 14px;
  font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;
  color:var(--muted);
  border-bottom:1px solid var(--line);
  white-space:nowrap;
  cursor:default;
}
th[title]{text-decoration:underline dotted var(--line-2)}
td{
  padding:9px 14px;
  border-bottom:1px solid var(--line);
  vertical-align:top;
  color:var(--ink);
}
tbody tr:last-child td{border-bottom:none}
tbody tr:nth-child(even) td{background:rgba(247,246,243,.5)}
tbody tr:hover td{background:var(--accent-soft)}
td.xs{font-size:12.5px;color:var(--ink-soft)}
td.mono{font-family:var(--mono);font-size:12px;color:var(--accent-strong)}
.muted{color:var(--muted)}
.trunc{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- Account display cells (two-line) --- */
.acct-primary{display:block;font-size:13px;color:var(--ink);font-weight:500}
.acct-secondary{display:block;font-size:11px;font-family:var(--mono);color:var(--muted);margin-top:1px}

/* --- Buttons --- */
button{
  font-family:var(--sans);
  background:var(--accent);color:#fff;
  border:none;border-radius:var(--r-xs);
  padding:7px 14px;font-size:13px;font-weight:600;
  cursor:pointer;
  transition:background .15s;
}
button:hover{background:var(--accent-strong)}
button.danger{background:#b3261e}
button.danger:hover{background:#9a1f18}
button.secondary{background:var(--paper);color:var(--ink-soft);border:1px solid var(--line-2)}
button.secondary:hover{background:var(--paper-2);color:var(--ink)}

/* --- Inputs --- */
input[type=email],input[type=text]{
  font-family:var(--sans);
  background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r-xs);
  color:var(--ink);padding:7px 12px;font-size:13px;
  transition:border-color .15s;
}
input[type=email]:focus,input[type=text]:focus{outline:none;border-color:var(--accent)}

/* --- Inline form row --- */
.inline-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}

/* --- Error details (expandable) --- */
.err-details>summary{font-size:11.5px;color:#9a2820;cursor:pointer}
.err{margin-top:4px;color:#9a2820;font-size:11px;line-height:1.4;max-width:360px;word-break:break-word}

/* --- Funnel bars --- */
.funnel-wrap{max-width:540px;display:flex;flex-direction:column;gap:14px}
.funnel-step{}
.funnel-label{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;gap:8px}
.funnel-name{font-size:13.5px;font-weight:500;color:var(--ink)}
.funnel-count{font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap}
.funnel-pct{font-weight:400;color:var(--muted);font-size:12px}
.funnel-track{background:var(--paper);border:1px solid var(--line);border-radius:999px;height:10px;overflow:hidden}
.funnel-bar{background:var(--accent);height:10px;border-radius:999px;min-width:3px;transition:width .3s ease}

/* --- Engagement top5 --- */
.top5{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:16px 20px;margin-bottom:18px}
.top5-label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px}
.top5-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
.top-item{font-size:13px;color:var(--ink-soft);display:flex;justify-content:space-between;align-items:center;gap:12px}
.top-count{font-weight:600;color:var(--accent-strong);white-space:nowrap}

/* --- Timestamp (sidebar footer) --- */
.timestamp{font-size:11.5px;color:var(--muted)}
</style>
</head>
<body>

${msg ? `
<!-- Dismissible banner (sticky at top of content) -->
<div class="banner-fixed" id="admin-banner" role="alert">
  <span class="banner-msg">${escapeHtml(msg)}</span>
  <button class="banner-close" onclick="document.getElementById('admin-banner').remove()" aria-label="Fechar">&times;</button>
</div>
` : ""}

<div class="shell">

<!-- Sidebar (desktop) -->
<aside class="sidebar">
  <a class="sidebar-brand" href="/admin?token=${encodeURIComponent(token)}">
    ${logoSvg}
    Zinom <span class="sidebar-sub">Admin</span>
  </a>
  <nav class="sidebar-nav" aria-label="Seções do admin">
    <a class="nav-item" href="#resumo" data-section="resumo">Resumo</a>
    <a class="nav-item" href="#receita" data-section="receita">Receita</a>
    <a class="nav-item" href="#funil" data-section="funil">Funil</a>
    <a class="nav-item" href="#engajamento" data-section="engajamento">Engajamento</a>
    <a class="nav-item" href="#custo" data-section="custo">Custo</a>
    <a class="nav-item" href="#qualidade-memoria" data-section="qualidade-memoria">Memória</a>
    <a class="nav-item" href="#uso-chat" data-section="uso-chat">Chat</a>
    <a class="nav-item" href="#armazenamento" data-section="armazenamento">Armazenamento</a>
    <a class="nav-item" href="#leads" data-section="leads">Leads</a>
    <a class="nav-item" href="#contas" data-section="contas">Contas</a>
  </nav>
  <div class="sidebar-footer">
    <span class="timestamp">${escapeHtml(now)}</span>
  </div>
</aside>

<!-- Mobile topbar -->
<div class="mobile-top">
  ${logoSvg}
  <span class="brand-name">Zinom Admin</span>
  <span class="view-name">${escapeHtml(now.slice(0, 10))}</span>
</div>

<!-- Mobile tabbar -->
<nav class="tabbar-mobile" aria-label="Seções">
  <a href="#resumo">Resumo</a>
  <a href="#receita">Receita</a>
  <a href="#funil">Funil</a>
  <a href="#engajamento">Engaj.</a>
  <a href="#custo">Custo</a>
  <a href="#qualidade-memoria">Memória</a>
  <a href="#uso-chat">Chat</a>
  <a href="#armazenamento">Storage</a>
  <a href="#leads">Leads</a>
  <a href="#contas">Contas</a>
</nav>

<!-- Main content -->
<main class="main">

<!-- ============================== RESUMO ============================== -->
<section class="section" id="resumo">
  <div class="section-header">
    <h2 class="section-title">Resumo</h2>
    <p class="section-desc">Visao geral do estado atual da plataforma. MRR aproximado calculado com base nos planos ativos no banco de dados (veja Receita para o valor ao vivo do Stripe).</p>
  </div>
  <div class="cards">
    <div class="card" title="Total de contas cadastradas na plataforma, incluindo owner e amigos">
      <div class="card-n">${data.accounts.length}</div>
      <div class="card-l">Contas</div>
      <small class="card-hint">total cadastrado</small>
    </div>
    <div class="card" title="Contas do tipo 'friend' — convidados pelo operador">
      <div class="card-n">${friends.length}</div>
      <div class="card-l">Amigos</div>
      <small class="card-hint">tipo friend</small>
    </div>
    <div class="card" title="Sessoes de portal ativas agora (cookie nao expirado)">
      <div class="card-n">${data.activeSessions}</div>
      <div class="card-l">Sessoes ativas</div>
      <small class="card-hint">cookies validos</small>
    </div>
    <div class="card" title="Convites resgatados sobre total emitido">
      <div class="card-n">${data.invites.redeemed}/${data.invites.total}</div>
      <div class="card-l">Convites usados</div>
      <small class="card-hint">resgatados / emitidos</small>
    </div>
    <div class="card" title="Solicitacoes de convite ainda aguardando envio">
      <div class="card-n">${pending}</div>
      <div class="card-l">Leads pendentes</div>
      <small class="card-hint">sem convite enviado</small>
    </div>
    <div class="card" title="MRR aproximado: soma dos planos ativos (nao cancelados) no banco">
      <div class="card-n">${mrr}</div>
      <div class="card-l">MRR (aprox.)</div>
      <small class="card-hint">via banco, nao Stripe</small>
    </div>
  </div>
</section>

<!-- ============================== RECEITA ============================== -->
${renderStripeSection(data)}

<!-- ============================== FUNIL ============================== -->
${renderFunnelSection(data)}

<!-- ============================== ENGAJAMENTO ============================== -->
${renderEngagementSection(data)}

<!-- ============================== CUSTO ============================== -->
${renderCostSection(data)}

<!-- ============================== QUALIDADE MEMORIA ============================== -->
${renderMemoryQualitySection(data)}

<!-- ============================== USO DO CHAT ============================== -->
${renderChatSection(data)}

<!-- ============================== ARMAZENAMENTO ============================== -->
${renderStorageSection(data)}

<!-- ============================== LEADS ============================== -->
<section class="section" id="leads">
  <div class="section-header">
    <h2 class="section-title">Solicitacoes de convite</h2>
    <p class="section-desc">Pessoas que solicitaram acesso. Clique em "Gerar e enviar convite" para emitir um codigo de uso unico e envia-lo por e-mail. Use o formulario abaixo para convidar um e-mail diretamente sem solicitacao previa.</p>
  </div>
  <form method="POST" action="${escapeHtml(action)}" class="inline-form">
    <input type="email" name="email" placeholder="convidar e-mail manualmente…" required>
    <button type="submit">Gerar e enviar convite</button>
  </form>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="E-mail da pessoa que solicitou acesso">E-mail</th>
      <th title="Nome informado na solicitacao">Nome</th>
      <th title="Mensagem livre da solicitacao">Nota</th>
      <th title="Data e hora da solicitacao">Solicitado em</th>
      <th title="Enviar convite ou ver status">Acao</th>
    </tr></thead>
    <tbody>
${leadRows || '<tr><td colspan="5" class="xs muted">Nenhuma solicitacao ainda.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>

<!-- ============================== CONTAS ============================== -->
<section class="section" id="contas">
  <div class="section-header">
    <h2 class="section-title">Contas</h2>
    <p class="section-desc">Todas as contas cadastradas. Colunas de uso mostram o mes corrente (desde ${escapeHtml(data.monthStart.toISOString().slice(0, 10))}). Passe o cursor sobre os cabecalhos para ver a descricao de cada coluna. Erros de indexacao ficam expansiveis na coluna "Indices".</p>
  </div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th title="Identificador unico da conta no Zinom">Conta</th>
      <th title="Tipo: owner (operador), friend (convidado)">Tipo</th>
      <th title="Estado atual: active ou suspended">Status</th>
      <th title="Plano contratado e status da assinatura">Plano</th>
      <th title="Data de renovacao do plano atual">Renova em</th>
      <th title="Fontes de dados conectadas (Notion, Granola, iCal, Google)">Fontes</th>
      <th title="Quantidade de tokens MCP emitidos para esta conta">MCP</th>
      <th title="Workspaces Notion vinculados a conta">Workspaces</th>
      <th title="Resultado do ultimo ciclo de indexacao por fonte — expanda para ver erros">Indices</th>
      <th title="Uso de metricas no mes corrente (embed_tokens, search, etc.)">Uso (mes)</th>
      <th title="Creditos de IA usados / limite do plano no mes corrente (F7)">Creditos</th>
      <th title="Data de criacao da conta">Criada</th>
      <th title="Bloquear ou reativar a conta">Acao</th>
    </tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</section>

</main>
</div><!-- /shell -->

<script>
/* Scrollspy: mark nav-item active when its section scrolls into view */
(function() {
  var items = document.querySelectorAll('.nav-item[data-section]');
  var sections = Array.from(items).map(function(el) {
    return document.getElementById(el.getAttribute('data-section'));
  }).filter(Boolean);
  if (!sections.length || !window.IntersectionObserver) return;
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        var id = e.target.id;
        items.forEach(function(el) {
          el.classList.toggle('active', el.getAttribute('data-section') === id);
        });
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach(function(s) { obs.observe(s); });
})();
</script>
</body>
</html>`;
}

export function createAdminRouter(bearerToken?: string): express.Router {
  const router = express.Router();
  const BASE_URL = process.env.BASE_URL ?? "https://zinom.ai";

  // Gate by the operator BEARER_TOKEN (header OR ?token=). Returns the token on
  // success (so server-rendered forms can carry it), or null after replying 401.
  // SECURITY (pentest F-1): operator token in query string — pending session-cookie redesign
  const gate = (req: express.Request, res: express.Response): string | null => {
    const auth = req.headers["authorization"];
    const headerToken = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const queryToken = typeof req.query.token === "string" ? req.query.token : null; // SECURITY (pentest F-1): operator token in query string — pending session-cookie redesign
    const token = headerToken ?? queryToken;
    if (!bearerToken || !token || !safeEqual(token, bearerToken)) {
      res.status(401).type("html").send("<!doctype html><meta charset=utf-8><p>401 — informe ?token=&lt;BEARER_TOKEN&gt;</p>");
      return null;
    }
    return token;
  };

  router.get("/admin", async (req, res) => {
    const token = gate(req, res);
    if (!token) return;
    const msg = typeof req.query.msg === "string" ? req.query.msg : "";
    try {
      const data = await gather();
      res.type("html").send(renderHtml(data, new Date().toISOString(), token, msg));
    } catch (err: any) {
      res.status(500).type("html").send(`<!doctype html><meta charset=utf-8><p>500 — ${escapeHtml(err?.message ?? "erro")}</p>`);
    }
  });

  // Generate a single-use invite, email it to the lead, and mark them invited.
  router.post("/admin/invite", async (req, res) => {
    const token = gate(req, res);
    if (!token) return;
    const back = `/admin?token=${encodeURIComponent(token)}`;
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.redirect(`${back}&msg=${encodeURIComponent("E-mail inválido.")}`);
      return;
    }
    try {
      const code = generateInviteCode();
      await issueInvite(code, `lead:${email}`);
      await sendInviteEmail(email, code, BASE_URL);
      await markRequestInvited(email, hashInvite(code));
      res.redirect(`${back}&msg=${encodeURIComponent(`Convite enviado para ${email}.`)}`);
    } catch (err: any) {
      console.error(`[admin] invite failed: ${err?.message ?? err}`);
      res.redirect(`${back}&msg=${encodeURIComponent(`Falha ao enviar: ${err?.message ?? "erro"}`)}`);
    }
  });

  // Block (suspend) an account: status='suspended', revoke its MCP bearers, audit.
  // Operator-gated; account_id is the target to act ON (operator-gated => OK).
  router.post("/admin/block", async (req, res) => {
    const token = gate(req, res);
    if (!token) return;
    const back = `/admin?token=${encodeURIComponent(token)}`;
    const accountId = typeof req.body?.account_id === "string" ? req.body.account_id.trim() : "";
    if (!accountId) {
      res.redirect(`${back}&msg=${encodeURIComponent("account_id obrigatório.")}`);
      return;
    }
    try {
      const { found, revoked } = await blockAccount(accountId);
      const msg = found
        ? `Conta ${accountId} bloqueada (${revoked} token(s) revogado(s)).`
        : `Conta ${accountId} não encontrada.`;
      res.redirect(`${back}&msg=${encodeURIComponent(msg)}`);
    } catch (err: any) {
      console.error(`[admin] block failed: ${err?.message ?? err}`);
      res.redirect(`${back}&msg=${encodeURIComponent(`Falha ao bloquear: ${err?.message ?? "erro"}`)}`);
    }
  });

  // Unblock (reactivate) an account: status='active', audit. Does not re-issue tokens.
  router.post("/admin/unblock", async (req, res) => {
    const token = gate(req, res);
    if (!token) return;
    const back = `/admin?token=${encodeURIComponent(token)}`;
    const accountId = typeof req.body?.account_id === "string" ? req.body.account_id.trim() : "";
    if (!accountId) {
      res.redirect(`${back}&msg=${encodeURIComponent("account_id obrigatório.")}`);
      return;
    }
    try {
      const { found } = await unblockAccount(accountId);
      const msg = found
        ? `Conta ${accountId} reativada.`
        : `Conta ${accountId} não encontrada.`;
      res.redirect(`${back}&msg=${encodeURIComponent(msg)}`);
    } catch (err: any) {
      console.error(`[admin] unblock failed: ${err?.message ?? err}`);
      res.redirect(`${back}&msg=${encodeURIComponent(`Falha ao reativar: ${err?.message ?? "erro"}`)}`);
    }
  });

  // Dismiss a lead: marks dismissed_at=now() without sending invite or deleting the row.
  router.post("/admin/lead/dismiss", async (req, res) => {
    const token = gate(req, res);
    if (!token) return;
    const back = `/admin?token=${encodeURIComponent(token)}`;
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email) {
      res.redirect(`${back}&msg=${encodeURIComponent("E-mail obrigatório.")}`);
      return;
    }
    try {
      await dismissInviteRequest(email);
      res.redirect(`${back}&msg=${encodeURIComponent(`Lead ${email} dispensado.`)}`);
    } catch (err: any) {
      console.error(`[admin] dismiss failed: ${err?.message ?? err}`);
      res.redirect(`${back}&msg=${encodeURIComponent(`Falha ao dispensar: ${err?.message ?? "erro"}`)}`);
    }
  });

  return router;
}
