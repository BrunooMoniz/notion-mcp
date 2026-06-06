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
  // Notion
  tag(document.getElementById("notion-tag"), s.notion && s.notion.connected, "conectado", "desconectado");
  document.getElementById("notion-status").textContent = statusLine(s.notion);

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

  await renderActivation(s);
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

document.getElementById("reindex").onclick = async () => {
  const res = await api("/portal/reindex", { method: "POST" });
  const el = document.getElementById("notion-notice");
  el.classList.remove("hidden");
  el.className = "notice";
  el.textContent = res.ok ? "Indexação iniciada. Volte daqui a pouco." : "Indexação indisponível neste ambiente.";
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

notionNotice();
load();
