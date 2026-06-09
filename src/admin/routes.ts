// src/admin/routes.ts
// 001-account-portal — operator admin dashboard. Read-only view of accounts,
// their connected sources, MCP tokens, last index runs, usage metering, and
// invite stats. Gated by the operator BEARER_TOKEN (header OR ?token=, same as
// /status) so only Bruno can see it. Server-rendered HTML (no client JS, no
// separate API surface), so the secret never lands in page JS.
import express from "express";
import { getPool } from "../rag/storage.js";
import { escapeHtml } from "../rag/status.js";
import { generateInviteCode, issueInvite, hashInvite } from "../portal/invites.js";
import { sendInviteEmail } from "../portal/email.js";
import { listInviteRequests, markRequestInvited, type InviteRequest } from "../portal/leads.js";
import { blockAccount, unblockAccount } from "./block.js";
import { monthStartUTC } from "../billing/usage.js";
import { getPlanLimits } from "../billing/plans.js";
import { ACTIVE_STATUS } from "../account-status.js";
import {
  buildFunnel,
  estimateCost,
  engagementOf,
  mrrFromSubscriptions,
  type FunnelRow,
  type EngagementRow,
  type StripeSub,
} from "./business.js";
import { getStripe } from "../billing/stripe.js";

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

  const { subs, source: stripeSource } = await fetchStripeSubs(p, Date.now());

  const byAcct = <T extends { account_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const arr = m.get(r.account_id) ?? [];
      arr.push(r);
      m.set(r.account_id, arr);
    }
    return m;
  };
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
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
        <span>${escapeHtml(s.label)}</span>
        <span style="color:#888">${s.count} (${s.pct}%)</span>
      </div>
      <div style="background:#262a33;border-radius:4px;height:10px;overflow:hidden">
        <div style="background:#1f8b4c;height:10px;width:${s.pct}%"></div>
      </div>
    </div>`,
    )
    .join("");
  return `<h2>Funil de ativação</h2>
<div style="max-width:480px">${bars}</div>`;
}

function renderStripeSection(data: Awaited<ReturnType<typeof gather>>): string {
  const { mrrCents, byStatus } = mrrFromSubscriptions(data.stripeSubs);
  const sourceLabel = data.stripeSource === "stripe" ? "Stripe API" : "DB (fallback)";
  const mrrFmt = `R$${(mrrCents / 100).toFixed(2)}`;
  const subRows = data.stripeSubs
    .map((s) => {
      const renewsAt = s.current_period_end
        ? new Date(s.current_period_end * 1000).toISOString().slice(0, 10)
        : "—";
      const amtFmt = `R$${(s.amount / 100).toFixed(2)}`;
      const acct = s.account_id ?? escapeHtml(s.customer);
      return `<tr>
        <td class="small"><code>${escapeHtml(acct)}</code></td>
        <td class="small">${amtFmt}</td>
        <td><span class="tag ${s.status === "active" ? "ok" : s.status === "canceled" ? "bad" : ""}">${escapeHtml(s.status)}</span></td>
        <td class="small">${escapeHtml(renewsAt)}</td>
      </tr>`;
    })
    .join("\n");
  return `<h2>Receita real (Stripe) <span class="tag" style="font-size:11px;vertical-align:middle">fonte: ${escapeHtml(sourceLabel)}</span></h2>
<div class="cards">
  <div class="card"><div class="n">${mrrFmt}</div><div class="l">MRR real</div></div>
  <div class="card"><div class="n">${byStatus.active ?? 0}</div><div class="l">active</div></div>
  <div class="card"><div class="n">${byStatus.past_due ?? 0}</div><div class="l">past_due</div></div>
  <div class="card"><div class="n">${byStatus.canceled ?? 0}</div><div class="l">canceled</div></div>
</div>
<table>
  <thead><tr><th>conta / customer</th><th>valor</th><th>status</th><th>renova em</th></tr></thead>
  <tbody>
${subRows || '<tr><td colspan="4" class="small">Nenhuma subscription encontrada.</td></tr>'}
  </tbody>
</table>`;
}

function renderEngagementSection(data: Awaited<ReturnType<typeof gather>>): string {
  const engMap = new Map(data.engagement.map((e) => [e.account_id, e]));
  // Top 5 by searches30d
  const top5 = [...data.engagement].sort((a, b) => b.searches30d - a.searches30d).slice(0, 5);
  const top5Html = top5.length
    ? top5
        .map(
          (e) =>
            `<li><code>${escapeHtml(e.account_id)}</code> — ${e.searches30d} buscas/30d</li>`,
        )
        .join("")
    : "<li>Nenhuma busca registrada.</li>";

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
          : "";
      return `<tr>
        <td class="small"><code>${escapeHtml(a.id)}</code></td>
        <td class="small">${s7}</td>
        <td class="small">${s30}</td>
        <td class="small">${escapeHtml(last)}</td>
        <td>${dormantTag}</td>
      </tr>`;
    })
    .join("\n");
  return `<h2>Uso e engajamento</h2>
<p class="sub">Top 5 do mês: <ol style="margin:4px 0 12px 18px;font-size:13px">${top5Html}</ol></p>
<table>
  <thead><tr><th>conta</th><th>buscas 7d</th><th>buscas 30d</th><th>última busca</th><th>estado</th></tr></thead>
  <tbody>
${rows || '<tr><td colspan="5" class="small">Nenhuma conta.</td></tr>'}
  </tbody>
</table>`;
}

function renderCostSection(data: Awaited<ReturnType<typeof gather>>): string {
  const costEnv: import("./business.js").CostEnv = {
    COST_EMBED_PER_MTOK: process.env.COST_EMBED_PER_MTOK,
    COST_PER_SEARCH: process.env.COST_PER_SEARCH,
  };
  const hasCostConfig = costEnv.COST_EMBED_PER_MTOK !== undefined && costEnv.COST_PER_SEARCH !== undefined;
  const warning = hasCostConfig ? "" : `<div class="banner" style="margin-bottom:12px">Configure COST_EMBED_PER_MTOK e COST_PER_SEARCH no .env para habilitar estimativas de custo.</div>`;

  const rows = data.accounts
    .map((a) => {
      const usageRows = data.usage.get(a.id) ?? [];
      const embedTokens = Number(usageRows.find((u) => u.metric === "embed_tokens")?.total ?? 0);
      const searches = Number(usageRows.find((u) => u.metric === "search")?.total ?? 0);
      const cost = estimateCost({ embed_tokens: embedTokens, searches }, costEnv);
      const planPrice = getPlanLimits(a.plan).priceBRLCents / 100;
      const margin = hasCostConfig ? planPrice - cost.totalCost : null;
      const fmtCost = hasCostConfig ? `$${cost.totalCost.toFixed(4)}` : "—";
      const fmtMargin = margin !== null ? `R$${margin.toFixed(2)}` : "—";
      return `<tr>
        <td class="small"><code>${escapeHtml(a.id)}</code></td>
        <td class="small">${escapeHtml(a.plan ?? "free")}</td>
        <td class="small">${embedTokens.toLocaleString()}</td>
        <td class="small">${searches}</td>
        <td class="small">${fmtCost}</td>
        <td class="small">${fmtMargin}</td>
      </tr>`;
    })
    .join("\n");
  return `<h2>Custo estimado / conta (mês) <span class="tag" style="font-size:11px;vertical-align:middle">estimativa</span></h2>
${warning}
<table>
  <thead><tr><th>conta</th><th>plano</th><th>embed_tokens</th><th>buscas</th><th>custo est.</th><th>margem</th></tr></thead>
  <tbody>
${rows || '<tr><td colspan="6" class="small">Nenhuma conta.</td></tr>'}
  </tbody>
</table>`;
}

function renderHtml(data: Awaited<ReturnType<typeof gather>>, now: string, token: string, msg: string): string {
  const friends = data.accounts.filter((a) => a.kind === "friend");
  const pending = data.leads.filter((l) => l.status === "pending").length;
  // Approx MRR: sum of active paid plans, priced from the plan matrix
  // (billing/plans.ts) so it never drifts from a hardcoded cents map.
  const mrrCents = data.accounts.reduce(
    (sum, a) => sum + (a.plan_status !== "canceled" ? getPlanLimits(a.plan).priceBRLCents : 0),
    0,
  );
  const mrr = `R$${(mrrCents / 100).toFixed(2)}`;
  const action = `/admin/invite?token=${encodeURIComponent(token)}`;
  const blockAction = `/admin/block?token=${encodeURIComponent(token)}`;
  const unblockAction = `/admin/unblock?token=${encodeURIComponent(token)}`;
  const rows = data.accounts
    .map((a) => {
      const usage = (data.usage.get(a.id) ?? []).map((u) => `${u.metric}:${u.total}`).join(" · ") || "—";
      // Latest failed-run error per source (truncated), shown beneath the ✓/✗ flags
      // so a red source explains itself.
      const errs = (data.errors.get(a.id) ?? [])
        .filter((e) => e.error)
        .map((e) => `${escapeHtml(e.source)}: ${escapeHtml(String(e.error).slice(0, 160))}`);
      const runs =
        ((data.runs.get(a.id) ?? [])
          .map((r) => `${escapeHtml(r.source)}${r.ok ? "✓" : "✗"}`)
          .join(" ") || "—") +
        (errs.length ? `<div class="err">${errs.join("<br>")}</div>` : "");
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
        ? '<span class="small">—</span>'
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
      return `<tr>
        <td><code>${escapeHtml(a.id)}</code></td>
        <td>${escapeHtml(a.email ?? "—")}</td>
        <td>${escapeHtml(a.kind ?? "—")}</td>
        <td>${statusCell}</td>
        <td>${escapeHtml(a.plan ?? "free")}${a.plan_status && a.plan_status !== "active" ? ` <span class="tag">${escapeHtml(a.plan_status)}</span>` : ""}</td>
        <td class="small">${escapeHtml(periodEnd)}</td>
        <td>${escapeHtml(sourceFlags(data.secrets.get(a.id)))}</td>
        <td>${data.tokens.get(a.id) ? "🔑×" + data.tokens.get(a.id) : "—"}</td>
        <td class="small">${ws ? escapeHtml(ws.join(", ")) : "—"}</td>
        <td class="small">${runs}</td>
        <td class="small">${escapeHtml(usage)}</td>
        <td class="small">${new Date(a.created_at).toLocaleString("pt-BR")}</td>
        <td>${actCell}</td>
      </tr>`;
    })
    .join("\n");

  const leadRows = data.leads
    .map((l) => {
      const act =
        l.status === "pending"
          ? `<form method="POST" action="${escapeHtml(action)}" style="margin:0">
               <input type="hidden" name="email" value="${escapeHtml(l.email)}">
               <button type="submit">Gerar e enviar convite</button>
             </form>`
          : `<span class="tag ok">convidado ${l.invited_at ? new Date(l.invited_at).toLocaleString("pt-BR") : ""}</span>`;
      return `<tr>
        <td>${escapeHtml(l.email)}</td>
        <td>${escapeHtml(l.name ?? "—")}</td>
        <td class="small">${escapeHtml(l.note ?? "—")}</td>
        <td class="small">${new Date(l.requested_at).toLocaleString("pt-BR")}</td>
        <td>${act}</td>
      </tr>`;
    })
    .join("\n");

  const banner = msg
    ? `<div class="banner">${escapeHtml(msg)}</div>`
    : "";

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zinom.ai — Admin</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 10px} .sub{color:#888;margin:0 0 20px;font-size:13px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#1a1d24;border:1px solid #262a33;border-radius:10px;padding:14px 18px;min-width:120px}
  .card .n{font-size:24px;font-weight:700} .card .l{color:#888;font-size:12px}
  table{width:100%;border-collapse:collapse;background:#1a1d24;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #262a33;vertical-align:top}
  th{color:#9aa;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  td.small{font-size:12px;color:#bbb} code{font:12px ui-monospace,monospace;color:#7fd1b9}
  tr:hover td{background:#20242d}
  button{background:#1f8b4c;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer}
  button:hover{background:#43a047}
  input[type=email],input[type=text]{background:#0f1115;border:1px solid #333;border-radius:7px;color:#fff;padding:7px 10px;font-size:13px}
  .tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#2a2f3a;color:#cbd5e1}
  .tag.ok{background:#15301f;color:#5fd39a}
  .tag.bad{background:#3a1517;color:#f49a9a}
  button.danger{background:#b3261e} button.danger:hover{background:#d33a30}
  .err{margin-top:4px;color:#f49a9a;font-size:11px;line-height:1.35;max-width:340px;word-break:break-word}
  .banner{background:#15301f;border:1px solid #2a5a3a;color:#9ae6b4;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px}
  .manual{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
</style></head><body>
<h1>🧠 Zinom.ai — Admin</h1>
<p class="sub">${now}</p>
${banner}
<div class="cards">
  <div class="card"><div class="n">${data.accounts.length}</div><div class="l">contas</div></div>
  <div class="card"><div class="n">${friends.length}</div><div class="l">amigos</div></div>
  <div class="card"><div class="n">${data.activeSessions}</div><div class="l">sessões ativas</div></div>
  <div class="card"><div class="n">${data.invites.redeemed}/${data.invites.total}</div><div class="l">convites usados</div></div>
  <div class="card"><div class="n">${pending}</div><div class="l">leads pendentes</div></div>
  <div class="card"><div class="n">${mrr}</div><div class="l">MRR (aprox.)</div></div>
</div>

<h2>Solicitações de convite (leads)</h2>
<form method="POST" action="${escapeHtml(action)}" class="manual">
  <input type="email" name="email" placeholder="convidar e-mail manualmente…" required>
  <button type="submit">Gerar e enviar convite</button>
</form>
<table>
  <thead><tr><th>email</th><th>nome</th><th>nota</th><th>solicitado</th><th>ação</th></tr></thead>
  <tbody>
${leadRows || '<tr><td colspan="5" class="small">Nenhuma solicitação ainda.</td></tr>'}
  </tbody>
</table>

<h2>Contas</h2>
<p class="sub">Uso da coluna abaixo é do mês corrente (desde ${escapeHtml(data.monthStart.toISOString().slice(0, 10))}).</p>
<table>
  <thead><tr>
    <th>account_id</th><th>email</th><th>tipo</th><th>status</th><th>plano</th><th>renova em</th><th>fontes</th><th>MCP</th>
    <th>workspaces</th><th>últimos índices</th><th>uso (mês)</th><th>criada</th><th>ação</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>

${renderStripeSection(data)}

${renderFunnelSection(data)}

${renderEngagementSection(data)}

${renderCostSection(data)}
</body></html>`;
}

export function createAdminRouter(bearerToken?: string): express.Router {
  const router = express.Router();
  const BASE_URL = process.env.BASE_URL ?? "https://zinom.ai";

  // Gate by the operator BEARER_TOKEN (header OR ?token=). Returns the token on
  // success (so server-rendered forms can carry it), or null after replying 401.
  const gate = (req: express.Request, res: express.Response): string | null => {
    const auth = req.headers["authorization"];
    const headerToken = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const queryToken = typeof req.query.token === "string" ? req.query.token : null;
    const token = headerToken ?? queryToken;
    if (!bearerToken || token !== bearerToken) {
      res.status(401).type("html").send("<!doctype html><meta charset=utf-8><p>401 — informe ?token=&lt;BEARER_TOKEN&gt;</p>");
      return null;
    }
    return token!;
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

  return router;
}
