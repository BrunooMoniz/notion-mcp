// portal/app.js — signed-in dashboard. Reads /portal/me, renders source status,
// and wires the credential management actions. All calls send the session cookie.
const API = window.PORTAL_API_BASE || "";

async function api(path, opts = {}) {
  return fetch(API + path, { credentials: "include", ...opts });
}
async function apiJSON(path, method, body) {
  return api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function tag(el, ok, onText, offText) {
  el.textContent = ok ? onText : offText;
  el.className = "tag " + (ok ? "ok" : "off");
}

async function load() {
  const res = await api("/portal/me");
  if (res.status === 401) {
    location.href = "/";
    return;
  }
  const me = await res.json();
  document.getElementById("who").textContent = me.email ? `Conectado como ${me.email}` : "Conectado";

  // MCP connection
  const mcp = me.mcp || {};
  document.getElementById("mcp-url").textContent = mcp.url || "—";
  document.getElementById("mcp-gen").textContent = mcp.configured ? "Gerar novo token" : "Gerar token de acesso";

  const s = me.sources || {};
  // Notion — repeatable list of connected workspaces (name + date + Remove)
  const notion = s.notion || {};
  tag(document.getElementById("notion-tag"), notion.connected, "conectado", "desconectado");
  document.getElementById("notion-status").textContent = statusLine(notion);
  renderNotionWorkspaces(notion.workspaces || []);

  // Granola
  const g = s.granola || {};
  tag(document.getElementById("granola-tag"), g.set, g.masked ? `chave ${g.masked}` : "com chave", "sem chave");

  // iCal
  const list = document.getElementById("ical-list");
  list.innerHTML = "";
  const links = (s.ical && s.ical.links) || [];
  if (!links.length) list.innerHTML = '<p class="muted">Nenhum calendário ainda.</p>';
  for (const l of links) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${escapeHtml(l.label || "(sem nome)")} <span class="muted">${escapeHtml(l.masked_url)}</span></span>`;
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Remover";
    btn.onclick = async () => {
      await api(`/portal/ical/${l.id}`, { method: "DELETE" });
      load();
    };
    row.appendChild(btn);
    list.appendChild(row);
  }

  await loadGoogleAccounts();
  await renderActivation(s);
}

async function loadGoogleAccounts() {
  const el = document.getElementById("google-accounts");
  if (!el) return;
  let accounts = [];
  try {
    const res = await api("/portal/google/accounts");
    if (res.ok) accounts = await res.json();
  } catch {
    /* ignore */
  }
  el.innerHTML = "";
  if (!accounts.length) {
    el.innerHTML = '<p class="muted">Nenhuma conta Google conectada.</p>';
    return;
  }
  for (const a of accounts) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${escapeHtml(a.email)}</span>`;
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Remover";
    btn.onclick = async () => {
      await apiJSON("/portal/google/disconnect", "POST", { email: a.email });
      load();
    };
    row.appendChild(btn);
    el.appendChild(row);
  }
}

// Repeatable Notion list: each connected workspace (human name + connected date)
// with a Remove button. Mirrors the iCal/Google list pattern. Removing purges the
// workspace's secrets + indexed chunks server-side (POST /portal/notion/disconnect).
function renderNotionWorkspaces(workspaces) {
  const list = document.getElementById("notion-list");
  if (!list) return;
  list.innerHTML = "";
  if (!workspaces.length) {
    list.innerHTML = '<p class="muted">Nenhum workspace do Notion conectado ainda.</p>';
    return;
  }
  for (const w of workspaces) {
    const name = w.name || w.workspace || "(workspace)";
    const when = w.connected_at ? new Date(w.connected_at).toLocaleDateString("pt-BR") : "";
    const row = document.createElement("div");
    row.className = "row";
    const meta = when ? ` <span class="muted">· conectado em ${escapeHtml(when)}</span>` : "";
    row.innerHTML = `<span>📄 ${escapeHtml(name)}${meta}</span>`;
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Remover";
    btn.onclick = async () => {
      if (!confirm(`Remover o Notion “${name}”? Isto apaga as chaves e tudo que já indexei desse workspace.`)) return;
      btn.disabled = true;
      await apiJSON("/portal/notion/disconnect", "POST", { workspace: w.workspace });
      load();
    };
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function statusLine(src) {
  if (!src || src.last_run == null) return "";
  const when = new Date(src.last_run).toLocaleString("pt-BR");
  return src.ok ? `Última indexação: ${when}` : `Erro na última indexação (${when}): ${src.error || ""}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function notionNotice() {
  const p = new URLSearchParams(location.search).get("notion");
  if (!p) return;
  const el = document.getElementById("notion-notice");
  el.classList.remove("hidden");
  if (p === "connected") { el.textContent = "Notion conectado!"; el.className = "notice"; }
  else if (p === "denied") { el.textContent = "Conexão do Notion cancelada."; el.className = "notice err"; }
  else { el.textContent = "Não consegui conectar o Notion. Tente de novo."; el.className = "notice err"; }
}

document.getElementById("logout").onclick = async () => {
  await api("/portal/logout", { method: "POST" });
  location.href = "/";
};

document.getElementById("notion-connect").onclick = (e) => {
  e.preventDefault();
  location.href = API + "/portal/notion/connect";
};

document.getElementById("pat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pat = document.getElementById("pat").value.trim();
  if (!pat) return;
  const msg = document.getElementById("pat-msg");
  msg.classList.remove("hidden");
  msg.textContent = "Validando…";
  const res = await apiJSON("/portal/notion/pat", "POST", { pat });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    document.getElementById("pat").value = "";
    msg.textContent = `Conectado via token: ${body.name || "Notion"}.`;
    load();
  } else {
    msg.textContent = body.error || "Falha ao validar o token.";
  }
});

document.getElementById("ical-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await apiJSON("/portal/ical", "POST", {
    url: document.getElementById("ical-url").value,
    label: document.getElementById("ical-label").value,
  });
  document.getElementById("ical-form").reset();
  load();
});

document.getElementById("granola-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = document.getElementById("granola-key").value;
  if (!key) return;
  await apiJSON("/portal/granola", "PUT", { key });
  document.getElementById("granola-key").value = "";
  load();
});

document.getElementById("granola-remove").onclick = async () => {
  await api("/portal/granola", { method: "DELETE" });
  load();
};

document.getElementById("mcp-gen").onclick = async () => {
  const res = await apiJSON("/portal/mcp-token", "POST");
  if (!res.ok) return;
  const { token, mcp_url } = await res.json();
  document.getElementById("mcp-token").value = token;
  document.getElementById("mcp-cmd").value =
    `claude mcp add --transport http zinom ${mcp_url} --header "Authorization: Bearer ${token}"`;
  document.getElementById("mcp-result").classList.remove("hidden");
  document.getElementById("mcp-gen").textContent = "Gerar novo token";
};

// Liberar conexão ao Claude.ai: abre uma janela curta de registro OAuth pra que o
// "Adicionar conector personalizado" do Claude.ai consiga se registrar. Mostra a
// contagem regressiva pra pessoa adicionar o conector dentro da janela.
let connectTimer = null;
document.getElementById("connect-open").onclick = async () => {
  const status = document.getElementById("connect-status");
  status.textContent = "Liberando…";
  const res = await apiJSON("/portal/connect-window", "POST");
  const b = await res.json().catch(() => ({}));
  if (!res.ok) {
    status.textContent = b.error || "Não consegui liberar agora. Tente de novo.";
    return;
  }
  const until = new Date(b.open_until).getTime();
  clearInterval(connectTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    if (left <= 0) {
      clearInterval(connectTimer);
      status.textContent = "Janela expirou — clique de novo se precisar.";
      return;
    }
    const m = Math.floor(left / 60), s = String(left % 60).padStart(2, "0");
    status.textContent = `✅ Liberado — adicione o conector no Claude.ai agora (${m}:${s})`;
  };
  tick();
  connectTimer = setInterval(tick, 1000);
};

document.getElementById("reindex").onclick = async () => {
  const res = await api("/portal/reindex", { method: "POST" });
  const el = document.getElementById("notion-notice");
  el.classList.remove("hidden");
  el.className = "notice";
  el.textContent = res.ok ? "Indexação iniciada — acompanhe em “Estado do meu Zinom” acima." : "Indexação indisponível neste ambiente.";
  if (res.ok) loadStatus(); // reflect "indexando…" + start polling immediately
};

// --- Ativação (checklist one-time) ------------------------------------------
const ACT_LABELS = { tasks: "Tarefas no Notion", granola: "Granola", ical: "Calendário", ask: "Pergunte ao Zinom" };

async function renderActivation(sources) {
  const res = await api("/portal/activation");
  if (!res.ok) return;
  const st = await res.json();
  const card = document.getElementById("activation");
  if (st.complete) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const ul = document.getElementById("activation-items");
  ul.innerHTML = "";
  for (const k of ["tasks", "granola", "ical", "ask"]) {
    const li = document.createElement("li");
    li.style.padding = "3px 0";
    li.textContent = `${st.items[k] ? "✅" : "⬜️"} ${ACT_LABELS[k]}`;
    ul.appendChild(li);
  }

  // Tarefas: se ainda não feito, oferecer detectar/criar.
  const taskBox = document.getElementById("act-tasks");
  if (st.items.tasks) {
    taskBox.classList.add("hidden");
  } else {
    taskBox.classList.remove("hidden");
    const notion = sources && sources.notion && sources.notion.connected;
    const msg = document.getElementById("act-tasks-msg");
    const actions = document.getElementById("act-tasks-actions");
    actions.innerHTML = "";
    if (!notion) {
      msg.textContent = "Conecte seu Notion acima primeiro — aí eu organizo suas tarefas.";
    } else {
      msg.textContent = "Vou procurar (ou criar) uma base de Tarefas no seu Notion.";
      const detectBtn = document.createElement("button");
      detectBtn.className = "small";
      detectBtn.textContent = "Procurar / criar Tarefas";
      detectBtn.onclick = () => detectTasks();
      actions.appendChild(detectBtn);
    }
  }

  // Pergunte ao Zinom: prompts calibrados; permite marcar como testado.
  const askBox = document.getElementById("act-ask");
  if (st.items.ask) {
    askBox.classList.add("hidden");
  } else {
    askBox.classList.remove("hidden");
    const prompts = document.getElementById("act-prompts");
    prompts.innerHTML = "";
    const list = ["o que rolou nas minhas últimas reuniões?", "o que ficou pendente sobre [meu projeto]?"];
    if (st.items.tasks) list.push("planeje meu dia");
    for (const p of list) {
      const li = document.createElement("li");
      li.textContent = `“${p}”`;
      prompts.appendChild(li);
    }
  }
}

async function detectTasks() {
  const actions = document.getElementById("act-tasks-actions");
  const msg = document.getElementById("act-tasks-msg");
  msg.textContent = "Procurando no seu Notion…";
  actions.innerHTML = "";
  const res = await apiJSON("/portal/tasks/detect", "POST");
  const det = await res.json().catch(() => ({ status: "error" }));
  if (det.status === "no-notion") {
    msg.textContent = "Conecte seu Notion acima primeiro.";
    return;
  }
  if (det.status === "none" || det.status === "error") {
    msg.textContent = "Não achei uma base de tarefas. Quero criar uma pra você (“🧠 Zinom › Tarefas”)?";
    const create = document.createElement("button");
    create.className = "small";
    create.textContent = "Criar Tarefas pra mim";
    create.onclick = createTasks;
    actions.appendChild(create);
    return;
  }
  // one/many: deixar a pessoa escolher usar uma existente, ou criar nova.
  msg.textContent = "Encontrei isto no seu Notion. Use uma, ou crie uma nova:";
  for (const c of det.candidates) {
    const b = document.createElement("button");
    b.className = "small";
    b.textContent = `Usar “${c.title}”`;
    b.onclick = () => useTasks(c.id);
    actions.appendChild(b);
  }
  const create = document.createElement("button");
  create.className = "small secondary";
  create.textContent = "Criar nova";
  create.onclick = createTasks;
  actions.appendChild(create);
}

async function createTasks() {
  const msg = document.getElementById("act-tasks-msg");
  msg.textContent = "Criando…";
  const res = await apiJSON("/portal/tasks/create", "POST");
  if (res.ok) { load(); } else {
    const b = await res.json().catch(() => ({}));
    msg.textContent = b.error || "Não consegui criar. Tente o token (PAT) no card do Notion.";
  }
}

async function useTasks(id) {
  await apiJSON("/portal/tasks/use", "POST", { data_source_id: id });
  load();
}

document.getElementById("act-ask-done").onclick = async () => {
  await apiJSON("/portal/activation/ask", "POST");
  load();
};
document.getElementById("act-dismiss").onclick = async () => {
  await apiJSON("/portal/activation/dismiss", "POST");
  load();
};

// --- Plano & Uso (Fase 3 billing) -------------------------------------------
const PLAN_LABELS = { free: "Free", essencial: "Essencial", pro: "Pro", ilimitado: "Ilimitado", owner: "Owner" };

// Compact summary only — the full screen (meters + upgrade + manage) is /plano.html.
async function loadBilling() {
  const planEl = document.getElementById("billing-plan");
  const lineEl = document.getElementById("billing-usage-line");
  try {
    const res = await api("/portal/billing");
    if (!res.ok) throw new Error("falha");
    const b = await res.json();
    const status = b.plan_status && b.plan_status !== "active" ? ` (${b.plan_status})` : "";
    planEl.textContent = (PLAN_LABELS[b.plan] || b.plan) + status;
    const lim = (v) => (v == null || !isFinite(v)) ? "ilimitado" : v.toLocaleString("pt-BR");
    const s = b.usage.searches, c = b.usage.chunks;
    lineEl.textContent = `Consultas este mês: ${s.used}/${lim(s.limit)} · Trechos indexados: ${c.used}/${lim(c.limit)}`;
  } catch {
    planEl.textContent = "—";
  }
}

// --- WS3: Estado do meu Zinom (status) + Navegar no meu cérebro -------------
const SRC_ICON = { notion: "📄", granola: "🎙️", calendar: "📅", web: "🌐" };
const SRC_LABEL = { notion: "Notion", granola: "Granola", calendar: "Calendário", web: "Web" };
let statusPollTimer = null;
function stopStatusPolling() { if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; } }

async function loadStatus() {
  let st;
  try {
    const res = await api("/portal/status");
    if (!res.ok) return;
    st = await res.json();
  } catch { return; }

  document.getElementById("brain-indexing").classList.toggle("hidden", !st.running);

  const totals = (st.counts && st.counts.totals) || { documents: 0, chunks: 0 };
  const totalsEl = document.getElementById("brain-totals");
  if (totals.documents > 0) {
    totalsEl.textContent = `${totals.documents} documentos · ${totals.chunks} trechos indexados`;
  } else {
    totalsEl.textContent = st.running
      ? "Indexando pela primeira vez… isto pode levar alguns minutos."
      : "Nada indexado ainda. Conecte suas fontes e clique em “Indexar meu Zinom agora”.";
  }

  // errors by source_type, from the per-source run status
  const errBy = {};
  for (const s of st.sources || []) {
    const t = s.source && s.source.startsWith("notion") ? "notion"
      : s.source && s.source.startsWith("granola") ? "granola"
      : s.source && s.source.startsWith("calendar") ? "calendar" : s.source;
    if (s.ok === false) errBy[t] = s.error || "erro";
  }
  const wrap = document.getElementById("brain-sources");
  wrap.innerHTML = "";
  for (const c of (st.counts && st.counts.bySource) || []) {
    const when = c.last_indexed_at ? new Date(c.last_indexed_at).toLocaleString("pt-BR") : "—";
    const err = errBy[c.source_type] ? ' <span class="tag off">erro</span>' : "";
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${SRC_ICON[c.source_type] || "•"} ${SRC_LABEL[c.source_type] || escapeHtml(c.source_type)} `
      + `<span class="muted">${c.documents} docs · ${c.chunks} trechos</span>${err}</span>`
      + `<span class="muted">${escapeHtml(when)}</span>`;
    wrap.appendChild(row);
  }

  if (st.running) {
    if (!statusPollTimer) statusPollTimer = setInterval(loadStatus, 4000);
  } else if (statusPollTimer) {
    // a run just finished — stop polling and refresh everything with fresh counts
    stopStatusPolling();
    load();
    loadBilling();
    loadBrain(true);
  }
}

// Brain navigator (browse indexed documents; cheap ILIKE filter, paginated)
let brainOffset = 0;
let brainQ = "";
let brainSourceType = "";
const PAGE = 50;

function renderBrainFilters() {
  const el = document.getElementById("brain-filters");
  el.innerHTML = "";
  const opts = [["", "Tudo"], ["notion", "📄 Notion"], ["granola", "🎙️ Granola"], ["calendar", "📅 Calendário"], ["web", "🌐 Web"]];
  for (const [val, label] of opts) {
    const b = document.createElement("button");
    b.className = "small" + (brainSourceType === val ? "" : " secondary");
    b.textContent = label;
    b.onclick = () => { brainSourceType = val; renderBrainFilters(); loadBrain(true); };
    el.appendChild(b);
  }
}

async function loadBrain(reset) {
  if (reset) brainOffset = 0;
  const params = new URLSearchParams();
  if (brainQ) params.set("q", brainQ);
  if (brainSourceType) params.set("source_type", brainSourceType);
  params.set("limit", String(PAGE));
  params.set("offset", String(brainOffset));
  let docs = [];
  try {
    const res = await api("/portal/brain/documents?" + params.toString());
    if (res.ok) docs = (await res.json()).documents || [];
  } catch { /* ignore */ }
  const wrap = document.getElementById("brain-docs");
  if (reset) wrap.innerHTML = "";
  if (reset && docs.length === 0) {
    wrap.innerHTML = '<p class="muted">Nada por aqui ainda. Conecte fontes e indexe, ou ajuste o filtro.</p>';
  }
  for (const d of docs) {
    const icon = SRC_ICON[d.source_type] || "•";
    const title = escapeHtml(d.title || "(sem título)");
    const inner = d.parent_url
      ? `<a href="${escapeHtml(d.parent_url)}" target="_blank" rel="noopener">${title}</a>`
      : title;
    const date = d.doc_date ? ` <span class="muted">· ${escapeHtml(d.doc_date)}</span>` : "";
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${icon} ${inner}${date}</span><span class="muted">${escapeHtml(d.db_name || SRC_LABEL[d.source_type] || "")}</span>`;
    wrap.appendChild(row);
  }
  brainOffset += docs.length;
  document.getElementById("brain-more").classList.toggle("hidden", docs.length < PAGE);
}

let brainQTimer = null;
document.getElementById("brain-q").addEventListener("input", (e) => {
  brainQ = e.target.value.trim();
  clearTimeout(brainQTimer);
  brainQTimer = setTimeout(() => loadBrain(true), 300);
});
document.getElementById("brain-more").onclick = () => loadBrain(false);

notionNotice();
load();
loadBilling();
loadStatus();
renderBrainFilters();
loadBrain(true);
