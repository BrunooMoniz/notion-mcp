// portal/plano.js — dedicated "Meu plano & consumo" screen.
// Reads /portal/billing (session-gated). Free/new users subscribe via Checkout;
// existing subscribers switch/cancel via the Stripe Customer Portal (so we never
// create a duplicate subscription). Redirects to login if there's no session.
const PLAN_LABELS = { free: "Free", essencial: "Essencial", pro: "Pro", ilimitado: "Ilimitado", owner: "Owner" };
const STATUS_LABELS = { past_due: "pagamento pendente", canceled: "cancelado", unpaid: "não pago", incomplete: "incompleto" };
const CHECK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function nf(n) { return Number(n).toLocaleString("pt-BR"); }
function isInf(v) { return v == null || !isFinite(v); }
function fmtLimit(v) { return isInf(v) ? "ilimitado" : nf(v); }
function brl(cents) { return (cents / 100).toFixed(2).replace(".", ","); }

function meter(label, used, limit) {
  const inf = isInf(limit);
  const pct = inf ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const cls = pct >= 100 ? "meter-bar over" : pct >= 80 ? "meter-bar warn" : "meter-bar";
  return `<div class="meter">
    <div class="meter-head"><span class="ml">${esc(label)}</span><span class="mv">${nf(used)} / ${fmtLimit(limit)}</span></div>
    <div class="meter-track"><div class="${cls}" style="width:${pct}%"></div></div>
  </div>`;
}

function planFeatures(p) {
  const items = [];
  items.push(`${p.maxWorkspaces} workspace${p.maxWorkspaces > 1 ? "s" : ""} do Notion`);
  items.push(`${nf(p.maxChunks)} trechos indexados`);
  items.push(`${nf(p.searchesPerMonth)} consultas / mês`);
  if (p.onDemandPagesPerDay > 0) items.push(`Indexação sob demanda (${p.onDemandPagesPerDay} pág/dia)`);
  if (p.features.granolaCalendar) items.push("Granola + Calendar");
  if (p.features.classifierRevisitar) items.push("Classificador + Revisitar");
  if (p.features.briefing) items.push("Briefing diário");
  return items.map((t) => `<li>${CHECK}<span>${esc(t)}</span></li>`).join("");
}

function setMsg(text, isErr) {
  const el = document.getElementById("msg");
  el.textContent = text || "";
  el.className = "msg" + (isErr ? " err" : "");
}

async function post(path) {
  return fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: arguments[1] ? JSON.stringify(arguments[1]) : undefined });
}

async function checkout(plan, btn) {
  btn.disabled = true; setMsg("Abrindo checkout…");
  try {
    const r = await post("/portal/billing/checkout", { plan });
    const d = await r.json().catch(() => ({}));
    if (d.url) { location.href = d.url; return; }
    setMsg(d.error || "Falha ao iniciar o checkout.", true);
  } catch { setMsg("Falha ao iniciar o checkout.", true); }
  btn.disabled = false;
}

async function manage(btn) {
  if (btn) btn.disabled = true; setMsg("Abrindo o portal de assinatura…");
  try {
    const r = await post("/portal/billing/manage");
    const d = await r.json().catch(() => ({}));
    if (d.url) { location.href = d.url; return; }
    setMsg(d.error || "Falha ao abrir o portal de assinatura.", true);
  } catch { setMsg("Falha ao abrir o portal de assinatura.", true); }
  if (btn) btn.disabled = false;
}

function renderPlan(b) {
  const row = document.getElementById("plan-row");
  const label = PLAN_LABELS[b.plan] || b.plan;
  const pill = `<span class="planpill ${b.plan === "free" ? "free" : ""}">${esc(label)}</span>`;
  let status = "";
  if (b.plan_status && b.plan_status !== "active") {
    status = `<span class="statustag warn">${esc(STATUS_LABELS[b.plan_status] || b.plan_status)}</span>`;
  }
  let renew = "";
  if (b.current_period_end) {
    const d = new Date(b.current_period_end);
    if (!isNaN(d)) renew = `<span class="renew">${b.plan_status === "canceled" ? "Acesso até" : "Renova em"} ${d.toLocaleDateString("pt-BR")}</span>`;
  }
  row.innerHTML = pill + status + renew;
}

function renderUsage(b) {
  const u = b.usage;
  document.getElementById("meters").innerHTML =
    meter("Consultas no mês", u.searches.used, u.searches.limit) +
    meter("Trechos indexados", u.chunks.used, u.chunks.limit) +
    meter("Páginas sob demanda (hoje)", u.onDemand.used, u.onDemand.limit);
}

function renderPlans(b) {
  const grid = document.getElementById("plans-grid");
  const title = document.getElementById("plans-title");
  if (b.plan === "owner") {
    title.textContent = "Planos";
    grid.innerHTML = `<p class="renew">Conta operador — acesso ilimitado.</p>`;
    return;
  }
  const subscribed = b.plan !== "free" && b.plan !== "owner";
  title.textContent = subscribed ? "Trocar de plano" : "Escolha um plano";
  grid.innerHTML = b.plans.map((p) => {
    const current = p.id === b.plan;
    const featured = p.id === "pro";
    const cls = "plan" + (current ? " current" : "") + (featured && !current ? " featured" : "");
    const badge = current ? `<span class="badge">Seu plano</span>` : (featured ? `<span class="badge">Mais popular</span>` : "");
    let btn;
    if (current) {
      btn = `<button class="btn btn-ghost btn-block" disabled>✓ Plano atual</button>`;
    } else if (subscribed) {
      btn = `<button class="btn btn-ghost btn-block" data-act="manage">Trocar para ${esc(p.label)}</button>`;
    } else {
      btn = `<button class="btn ${featured ? "btn-primary" : "btn-ghost"} btn-block" data-act="checkout" data-plan="${esc(p.id)}">Assinar</button>`;
    }
    return `<div class="${cls}">${badge}
      <div class="pname">${esc(p.label)}</div>
      <div class="price"><span class="cur">R$</span><span class="amt">${brl(p.priceBRLCents).split(",")[0]}</span><span class="per">,${brl(p.priceBRLCents).split(",")[1]}/mês</span></div>
      <ul class="pfeats">${planFeatures(p)}</ul>
      ${btn}
    </div>`;
  }).join("");

  // wire buttons
  grid.querySelectorAll('[data-act="checkout"]').forEach((b2) => b2.addEventListener("click", () => checkout(b2.dataset.plan, b2)));
  grid.querySelectorAll('[data-act="manage"]').forEach((b2) => b2.addEventListener("click", () => manage(b2)));

  // standalone manage link (cancel / change card) for existing customers
  if (b.manage_available) {
    const p = document.createElement("p");
    p.style.cssText = "margin-top:18px;font-size:13.5px";
    p.innerHTML = `<a href="#" id="manage-link" style="color:var(--accent-strong);font-weight:520">Gerenciar assinatura (trocar cartão, cancelar)</a>`;
    document.getElementById("plans-card").insertBefore(p, document.getElementById("msg"));
    document.getElementById("manage-link").addEventListener("click", (e) => { e.preventDefault(); manage(null); });
  }
}

async function load() {
  let r;
  try {
    r = await fetch("/portal/billing", { credentials: "same-origin" });
  } catch {
    document.getElementById("meters").innerHTML = `<p class="renew">Sem conexão. Tente recarregar.</p>`;
    return;
  }
  if (r.status === 401) { location.href = "/#acesso"; return; }
  if (!r.ok) { document.getElementById("meters").innerHTML = `<p class="renew">Não foi possível carregar o plano.</p>`; return; }
  const b = await r.json();
  renderPlan(b);
  renderUsage(b);
  renderPlans(b);
  // success/cancel feedback from a returning Checkout redirect
  const qs = new URLSearchParams(location.search);
  if (qs.get("billing") === "success") setMsg("Pagamento confirmado! Seu plano será atualizado em instantes.");
  else if (qs.get("billing") === "cancel") setMsg("Checkout cancelado.");
}

document.getElementById("logout").addEventListener("click", async () => {
  try { await post("/portal/logout"); } catch {}
  location.href = "/";
});

load();
