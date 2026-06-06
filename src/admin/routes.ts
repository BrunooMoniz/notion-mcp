// src/admin/routes.ts
// 001-account-portal — operator admin dashboard. Read-only view of accounts,
// their connected sources, MCP tokens, last index runs, usage metering, and
// invite stats. Gated by the operator BEARER_TOKEN (header OR ?token=, same as
// /status) so only Bruno can see it. Server-rendered HTML (no client JS, no
// separate API surface), so the secret never lands in page JS.
import express from "express";
import { getPool } from "../rag/storage.js";
import { escapeHtml } from "../rag/status.js";

interface AccountRow {
  id: string;
  kind: string | null;
  email: string | null;
  status: string | null;
  created_at: Date;
}

async function gather() {
  const p = getPool();
  const [accounts, secrets, workspaces, tokens, usage, runs, invites, sessions] = await Promise.all([
    p.query<AccountRow>(`SELECT id, kind, email, status, created_at FROM account ORDER BY created_at`),
    p.query<{ account_id: string; kinds: string[] }>(
      `SELECT account_id, array_agg(kind ORDER BY kind) AS kinds FROM account_secrets GROUP BY account_id`),
    p.query<{ account_id: string; ws: string[] }>(
      `SELECT account_id, array_agg(workspace ORDER BY workspace) AS ws FROM account_workspaces GROUP BY account_id`),
    p.query<{ account_id: string; n: string }>(
      `SELECT account_id, count(*)::text AS n FROM account_api_tokens GROUP BY account_id`),
    p.query<{ account_id: string; metric: string; total: string }>(
      `SELECT account_id, metric, sum(qty)::text AS total FROM usage_log GROUP BY account_id, metric`),
    p.query<{ account_id: string; source: string; ok: boolean; ended_at: Date }>(
      `SELECT DISTINCT ON (account_id, source) account_id, source, ok, ended_at
       FROM status_runs ORDER BY account_id, source, ended_at DESC`),
    p.query<{ total: string; redeemed: string }>(
      `SELECT count(*)::text AS total, count(redeemed_at)::text AS redeemed FROM invite_codes`),
    p.query<{ n: string }>(`SELECT count(*)::text AS n FROM portal_sessions WHERE expires_at > now()`),
  ]);

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
    invites: invites.rows[0] ?? { total: "0", redeemed: "0" },
    activeSessions: sessions.rows[0]?.n ?? "0",
  };
}

function sourceFlags(kinds: string[] | undefined): string {
  if (!kinds) return "—";
  const has = (prefix: string) => kinds.some((k) => k === prefix || k.startsWith(prefix + ":"));
  const tags: string[] = [];
  if (has("notion_access") || has("notion_pat")) tags.push("Notion");
  if (kinds.includes("granola")) tags.push("Granola");
  if (kinds.includes("ical")) tags.push("iCal");
  return tags.length ? tags.join(", ") : "—";
}

function renderHtml(data: Awaited<ReturnType<typeof gather>>, now: string): string {
  const friends = data.accounts.filter((a) => a.kind === "friend");
  const rows = data.accounts
    .map((a) => {
      const usage = (data.usage.get(a.id) ?? []).map((u) => `${u.metric}:${u.total}`).join(" · ") || "—";
      const runs = (data.runs.get(a.id) ?? [])
        .map((r) => `${escapeHtml(r.source)}${r.ok ? "✓" : "✗"}`)
        .join(" ") || "—";
      const ws = data.workspaces.get(a.id);
      return `<tr>
        <td><code>${escapeHtml(a.id)}</code></td>
        <td>${escapeHtml(a.email ?? "—")}</td>
        <td>${escapeHtml(a.kind ?? "—")}</td>
        <td>${escapeHtml(sourceFlags(data.secrets.get(a.id)))}</td>
        <td>${data.tokens.get(a.id) ? "🔑×" + data.tokens.get(a.id) : "—"}</td>
        <td class="small">${ws ? escapeHtml(ws.join(", ")) : "—"}</td>
        <td class="small">${runs}</td>
        <td class="small">${escapeHtml(usage)}</td>
        <td class="small">${new Date(a.created_at).toLocaleString("pt-BR")}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Segundo Cérebro</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#888;margin:0 0 20px;font-size:13px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#1a1d24;border:1px solid #262a33;border-radius:10px;padding:14px 18px;min-width:120px}
  .card .n{font-size:24px;font-weight:700} .card .l{color:#888;font-size:12px}
  table{width:100%;border-collapse:collapse;background:#1a1d24;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #262a33;vertical-align:top}
  th{color:#9aa;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  td.small{font-size:12px;color:#bbb} code{font:12px ui-monospace,monospace;color:#7fd1b9}
  tr:hover td{background:#20242d}
</style></head><body>
<h1>🧠 Admin — Segundo Cérebro</h1>
<p class="sub">${now}</p>
<div class="cards">
  <div class="card"><div class="n">${data.accounts.length}</div><div class="l">contas</div></div>
  <div class="card"><div class="n">${friends.length}</div><div class="l">amigos</div></div>
  <div class="card"><div class="n">${data.activeSessions}</div><div class="l">sessões ativas</div></div>
  <div class="card"><div class="n">${data.invites.redeemed}/${data.invites.total}</div><div class="l">convites usados</div></div>
</div>
<table>
  <thead><tr>
    <th>account_id</th><th>email</th><th>tipo</th><th>fontes</th><th>MCP</th>
    <th>workspaces</th><th>últimos índices</th><th>uso</th><th>criada</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body></html>`;
}

export function createAdminRouter(bearerToken?: string): express.Router {
  const router = express.Router();

  router.get("/admin", async (req, res) => {
    const auth = req.headers["authorization"];
    const headerToken = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const queryToken = typeof req.query.token === "string" ? req.query.token : null;
    const token = headerToken ?? queryToken;
    if (!bearerToken || token !== bearerToken) {
      res
        .status(401)
        .type("html")
        .send("<!doctype html><meta charset=utf-8><p>401 — informe ?token=&lt;BEARER_TOKEN&gt;</p>");
      return;
    }
    try {
      const data = await gather();
      res.type("html").send(renderHtml(data, new Date().toISOString()));
    } catch (err: any) {
      res.status(500).type("html").send(`<!doctype html><meta charset=utf-8><p>500 — ${escapeHtml(err?.message ?? "erro")}</p>`);
    }
  });

  return router;
}
