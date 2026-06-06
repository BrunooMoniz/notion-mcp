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

document.getElementById("reindex").onclick = async () => {
  const res = await api("/portal/reindex", { method: "POST" });
  const el = document.getElementById("notion-notice");
  el.classList.remove("hidden");
  el.className = "notice";
  el.textContent = res.ok ? "Indexação iniciada. Volte daqui a pouco." : "Indexação indisponível neste ambiente.";
};

notionNotice();
load();
