/* =====================================================================
   Zinom — portal app.js
   Design: /tmp/zinom-design/zinom-ai/ (redesign da área logada)
   Dados: APIs reais (/portal/me, /portal/sources, /portal/status, etc.)
   ===================================================================== */
'use strict';

const API = window.PORTAL_API_BASE || '';

/* ---- helpers de fetch ---- */
async function api(path, opts) {
  return fetch(API + path, Object.assign({ credentials: 'include' }, opts));
}
async function apiJSON(path, method, body) {
  return api(path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/* ---- helpers de segurança e formatação ---- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR');
}

/* ---- toast ---- */
var toastTimer = null;
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
}

/* ---- ícones de fonte (SVG inline) ---- */
var ICONS = {
  notion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3.5h8.5L19 8v12.5H6z" stroke-linejoin="round"/><path d="M14 3.5V8h4.5" stroke-linejoin="round"/><path d="M9 12.5h7M9 15.8h7" stroke-linecap="round"/></svg>',
  granola: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.8h17M8 2.8v4M16 2.8v4" stroke-linecap="round"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.1-3.9-8.5s1.3-6.2 3.9-8.5z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 9.5 3 2.7-3 2.7M13 15h4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
var ICON_COLOR = { notion: '#26241f', granola: '#a07b13', calendar: '#3a6fb0', web: '#6b6458', spark: '#7a5f3c', term: '#4a4740' };
var TYPE_LABEL = { notion: 'Notion', granola: 'Reuniao', calendar: 'Agenda', web: 'Web' };

function srcIcon(type) {
  var ic = ICONS[type] || ICONS.web;
  var co = ICON_COLOR[type] || '#6b6458';
  return '<span class="si" style="color:' + co + '">' + ic + '</span>';
}

function logoSvg(size) {
  size = size || 26;
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 26 26" fill="none" aria-hidden="true">' +
    '<rect x="1" y="1" width="24" height="24" rx="7.5" fill="var(--accent)"/>' +
    '<path d="M8 8 H18 L8 18 H18" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="8" cy="8" r="1.7" fill="#fff"/><circle cx="18" cy="8" r="1.7" fill="#fff"/>' +
    '<circle cx="8" cy="18" r="1.7" fill="#fff"/><circle cx="18" cy="18" r="1.7" fill="#fff"/></svg>';
}

/* ---- navegação por hash ---- */
var VIEWS = ['inicio', 'chat', 'fontes', 'atividade', 'guia'];

function go(view) {
  // plano vai para /plano.html (link externo)
  if (view === 'plano') { location.href = '/plano.html'; return; }
  if (!VIEWS.includes(view)) view = 'inicio';
  document.querySelectorAll('.view').forEach(function (v) {
    v.classList.toggle('active', v.id === 'view-' + view);
  });
  document.querySelectorAll('[data-nav]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-nav') === view);
  });
  var mn = document.getElementById('mobile-view-name');
  if (mn) mn.textContent = view;
  document.scrollingElement.scrollTo({ top: 0 });
  try { history.replaceState(null, '', '#' + view); } catch (e) { /* sandbox */ }
}

/* ==================== INÍCIO ====================
   Pipeline + assistentes (tokens MCP reais via /portal/mcp-tokens e /portal/me)
   ================================================ */

/* estado local de assistentes (tokens) */
var assistants = [];

function renderInicio(me, billing) {
  /* logo no pipeline */
  var plLogo = document.getElementById('pl-logo');
  if (plLogo) plLogo.innerHTML = logoSvg(30);

  /* pipeline: fontes */
  var sources = (me && me.sources) || {};
  var nActive = 0;
  if (sources.notion && sources.notion.connected) nActive++;
  if (sources.google && sources.google.length) nActive++;
  if (sources.ical && sources.ical.links && sources.ical.links.length) nActive++;
  if (sources.granola && sources.granola.set) nActive++;
  var plSrc = document.getElementById('pl-sources');
  if (plSrc) {
    plSrc.innerHTML = ['notion', 'granola', 'calendar', 'web'].map(srcIcon).join('');
  }
  var plSrcN = document.getElementById('pl-sources-n');
  if (plSrcN) plSrcN.textContent = nActive + ' ativas';

  /* pipeline: status do cérebro (do /portal/status) */
  renderBrainMini(false, null);

  /* pipeline: assistentes */
  var plAss = document.getElementById('pl-assistants');
  var plAssN = document.getElementById('pl-assistants-n');
  var assTag = document.getElementById('assistants-tag');
  if (plAss) {
    plAss.innerHTML = assistants.length
      ? assistants.map(function (a) { return srcIcon(a.icon || 'term'); }).join('')
      : '<span class="si" style="color:#c6c1b6">' + ICONS.spark + '</span>';
  }
  if (plAssN) plAssN.textContent = assistants.length
    ? assistants.length + (assistants.length > 1 ? ' conectados' : ' conectado')
    : 'nenhum ainda';
  if (assTag) assTag.textContent = assistants.length;

  /* lista de assistentes conectados */
  var alEl = document.getElementById('assistant-list');
  if (alEl) {
    alEl.innerHTML = assistants.length
      ? assistants.map(function (a, i) {
          return '<div class="row">' + srcIcon(a.icon || 'term') +
            '<span class="grow"><span class="ttl">' + escapeHtml(a.name) + '</span>' +
            '<span class="meta">' + escapeHtml(a.via || '') + (a.meta ? ' · ' + escapeHtml(a.meta) : '') + '</span></span>' +
            '<span class="tag ok">ativo</span>' +
            '<button class="btn btn-danger-ghost btn-sm" type="button" data-rm-assist="' + escapeHtml(String(a.id)) + '">Revogar</button></div>';
        }).join('')
      : '<p class="muted">Nenhum assistente conectado ainda — siga um dos caminhos abaixo. Leva menos de 5 minutos.</p>';
  }

  /* billing resumo */
  if (billing) {
    var planEl = document.getElementById('billing-plan');
    var lineEl = document.getElementById('billing-usage-line');
    var PLAN_LABELS = { free: 'Free', essencial: 'Essencial', pro: 'Pro', ilimitado: 'Ilimitado', owner: 'Owner' };
    if (planEl) {
      var status = billing.plan_status && billing.plan_status !== 'active' ? ' (' + billing.plan_status + ')' : '';
      planEl.textContent = (PLAN_LABELS[billing.plan] || billing.plan || '—') + status;
    }
    if (lineEl) {
      var lim = function (v) { return (v == null || !isFinite(v)) ? 'ilimitado' : fmt(v); };
      var sc = billing.usage && billing.usage.searches;
      var ch = billing.usage && billing.usage.chunks;
      if (sc && ch) {
        lineEl.textContent = 'Consultas: ' + sc.used + '/' + lim(sc.limit) + ' · Trechos: ' + ch.used + '/' + lim(ch.limit);
      }
    }
  }
}

/* ---- carregar tokens MCP como assistentes ---- */
async function loadMcpTokens() {
  try {
    var res = await api('/portal/mcp-tokens');
    if (!res.ok) return;
    var list = await res.json();
    assistants = (list || []).map(function (t) {
      return {
        id: t.id,
        name: t.label || 'Claude Code',
        icon: 'term',
        via: 'token ••••' + (t.id ? String(t.id).slice(-4) : ''),
        meta: t.created_at ? 'criado em ' + new Date(t.created_at).toLocaleDateString('pt-BR') : ''
      };
    });
  } catch (e) { /* ignora */ }
}

/* ---- revogar assistente / token ---- */
async function revokeAssistant(tokenId) {
  try {
    var res = await apiJSON('/portal/mcp-tokens/revoke', 'POST', { id: tokenId });
    if (!res.ok) { toast('Não consegui revogar. Tente de novo.'); return; }
    toast('Token revogado — assistente removido');
    await loadMcpTokens();
    renderInicio(window._lastMe, window._lastBilling);
  } catch (e) { toast('Erro de rede ao revogar.'); }
}

/* ==================== SIDEBAR / cérebro ====================  */

function renderBrainMini(busy, st) {
  var dot = document.getElementById('brain-dot');
  var chunks = document.getElementById('brain-mini-chunks');
  var sync = document.getElementById('brain-mini-sync');
  if (!dot || !chunks || !sync) return;
  dot.classList.toggle('busy', !!busy);
  if (st && st.counts && st.counts.totals) {
    chunks.textContent = fmt(st.counts.totals.chunks || 0);
    var lastAt = (st.counts.bySource || []).reduce(function (m, s) {
      return s.last_indexed_at && s.last_indexed_at > m ? s.last_indexed_at : m;
    }, '');
    sync.textContent = busy ? 'indexando agora…'
      : (lastAt ? 'sincronizado ' + new Date(lastAt).toLocaleString('pt-BR') : 'nunca indexado');
  } else {
    chunks.textContent = '—';
    sync.textContent = busy ? 'indexando agora…' : 'sincronizado';
  }
}

/* ==================== FONTES ====================  */

function renderFontes(me) {
  var sources = (me && me.sources) || {};

  /* google unconfigured */
  var gcUnconfigured = document.getElementById('google-unconfigured');
  if (gcUnconfigured) {
    var googleOk = me && me.google_configured !== false;
    gcUnconfigured.classList.toggle('hidden', googleOk);
    var gaBtn = document.getElementById('google-add');
    if (gaBtn) gaBtn.disabled = !googleOk;
  }

  /* notion */
  var notion = sources.notion || {};
  var ntTag = document.getElementById('notion-tag');
  if (ntTag) {
    var workspaces = notion.workspaces || [];
    ntTag.textContent = workspaces.length
      ? (workspaces.length > 1 ? workspaces.length + ' workspaces' : 'conectado')
      : 'desconectado';
    ntTag.className = 'tag ' + (workspaces.length ? 'ok' : 'off');
  }
  var nList = document.getElementById('notion-list');
  if (nList) {
    var ws = notion.workspaces || [];
    nList.innerHTML = ws.length
      ? ws.map(function (w) {
          var name = w.name || w.workspace || '(workspace)';
          var when = w.connected_at ? new Date(w.connected_at).toLocaleDateString('pt-BR') : '';
          var connChip = w.connection_type === 'pat' ? '<span class="tag">Token (PAT)</span>' : w.connection_type === 'oauth' ? '<span class="tag">OAuth</span>' : '';
          return '<div class="row">' + srcIcon('notion') +
            '<span class="grow"><span class="ttl">' + escapeHtml(name) + '</span>' +
            '<span class="meta">' + (when ? 'conectado em ' + when : '') + '</span></span>' +
            connChip +
            '<button class="btn btn-danger-ghost btn-sm" type="button" data-rm-notion="' + escapeHtml(w.workspace || name) + '">Remover</button></div>';
        }).join('')
      : '<p class="muted">Nenhum workspace conectado ainda. O Notion costuma ser a fonte mais rica do cerebro.</p>';
  }

  /* fontes-count + badge */
  var nConn = (notion.connected ? 1 : 0) + (sources.google && sources.google.length ? 1 : 0)
    + (sources.ical && sources.ical.links && sources.ical.links.length ? 1 : 0)
    + (sources.granola && sources.granola.set ? 1 : 0);
  var fcEl = document.getElementById('fontes-count');
  if (fcEl) fcEl.textContent = '· ' + nConn + ' conectadas';
  var nbEl = document.getElementById('nav-fontes-badge');
  if (nbEl) nbEl.textContent = nConn;

  /* google */
  var gAccounts = sources.google || [];
  var gTag = document.getElementById('google-tag');
  if (gTag) {
    gTag.textContent = gAccounts.length ? gAccounts.length + (gAccounts.length > 1 ? ' contas' : ' conta') : 'nenhuma conta';
    gTag.className = 'tag ' + (gAccounts.length ? 'ok' : '');
  }
  var gList = document.getElementById('google-list');
  if (gList) {
    gList.innerHTML = gAccounts.length
      ? gAccounts.map(function (em) {
          return '<div class="row">' + srcIcon('calendar') +
            '<span class="grow"><span class="ttl">' + escapeHtml(em) + '</span>' +
            '<span class="meta">leitura e escrita de eventos</span></span>' +
            '<button class="btn btn-danger-ghost btn-sm" type="button" data-rm-google="' + escapeHtml(em) + '">Remover</button></div>';
        }).join('')
      : '<p class="muted">Nenhuma conta conectada.</p>';
  }

  /* ical */
  var icalLinks = (sources.ical && sources.ical.links) || [];
  var iList = document.getElementById('ical-list');
  if (iList) {
    iList.innerHTML = icalLinks.length
      ? icalLinks.map(function (c) {
          return '<div class="row">' + srcIcon('calendar') +
            '<span class="grow"><span class="ttl">' + escapeHtml(c.label || 'Sem nome') + '</span>' +
            '<span class="meta masked">' + escapeHtml(c.masked_url || c.url || '') + '</span></span>' +
            '<button class="btn btn-danger-ghost btn-sm" type="button" data-rm-ical="' + escapeHtml(String(c.id)) + '">Remover</button></div>';
        }).join('')
      : '<p class="muted">Nenhum calendario por link ainda.</p>';
  }

  /* granola */
  var granola = sources.granola || {};
  var grTag = document.getElementById('granola-tag');
  if (grTag) {
    grTag.textContent = granola.set ? 'chave salva' : 'sem chave';
    grTag.className = 'tag ' + (granola.set ? 'ok' : '');
  }
  var grState = document.getElementById('granola-state');
  if (grState) {
    grState.innerHTML = granola.set
      ? '<div class="row">' + srcIcon('granola') +
        '<span class="grow"><span class="ttl">Chave da API</span>' +
        '<span class="meta masked">' + escapeHtml(granola.masked || '••••') + '</span></span>' +
        '<span class="tag ok">ativa</span></div>'
      : '<p class="muted">Cole a chave abaixo — ela fica guardada criptografada e aparece sempre mascarada.</p>';
  }
  var grKey = document.getElementById('granola-key');
  if (grKey) grKey.placeholder = granola.set ? 'Colar nova chave para trocar' : 'Cole a chave da API do Granola';
  var grSave = document.getElementById('granola-save');
  if (grSave) grSave.textContent = granola.set ? 'Trocar' : 'Salvar';
  var grRm = document.getElementById('granola-remove');
  if (grRm) grRm.classList.toggle('hidden', !granola.set);
}

/* ==================== ENTIDADES ====================  */

var entityState = { expanded: { pessoa: false, empresa: false, projeto: false }, entityQ: '' };
var _entitiesCache = null;

/* Singular type labels for disambiguation suffixes (chips + pills). */
var TYPE_LABEL_SINGULAR = { pessoa: 'pessoa', empresa: 'empresa', projeto: 'projeto' };

/* Names that exist under more than one entity (any type) in the current cache.
 * Memoized per cache identity so we recompute only when entities reload. */
var _ambiguousNames = null;
var _ambiguousNamesFor = null;
function getAmbiguousNames() {
  if (_ambiguousNamesFor === _entitiesCache && _ambiguousNames) return _ambiguousNames;
  var seen = Object.create(null);
  var dupes = Object.create(null);
  (_entitiesCache || []).forEach(function (e) {
    var key = (e.name || '').toLowerCase();
    if (seen[key]) dupes[key] = true;
    seen[key] = true;
  });
  _ambiguousNames = dupes;
  _ambiguousNamesFor = _entitiesCache;
  return dupes;
}

/* True when the given name collides with another entity (so we must show type). */
function isAmbiguousName(name) {
  return !!getAmbiguousNames()[(name || '').toLowerCase()];
}

// COMPAT: kept for any code that reads _activeEntityId (e.g. openGraphPanel)
Object.defineProperty(window, '_activeEntityId', {
  get: function() { return explorerState.entityIds.size === 1 ? explorerState.entityIds.values().next().value : null; },
  set: function(v) {
    if (v === null) { explorerState.entityIds.clear(); }
    else { explorerState.entityIds.add(v); }
  }
});

async function loadEntities() {
  var wrap = document.getElementById('entities-block');
  if (!wrap) return;
  wrap.innerHTML = '<span class="muted" style="font-size:13px">carregando entidades…</span>';
  try {
    var res = await api('/portal/brain/entities');
    if (!res.ok && res.status !== 503) { renderEntitiesEmpty(wrap); return; }
    var data = res.ok ? await res.json() : { entities: [], total: 0 };
    _entitiesCache = data.entities || [];
    renderEntities(wrap, _entitiesCache);
    // Show entity search input when there are many entities
    var esInput = document.getElementById('entity-search');
    if (esInput) esInput.style.display = _entitiesCache.length > 30 ? 'block' : 'none';
  } catch (e) {
    wrap.innerHTML = '<span class="muted" style="font-size:13px">Erro ao carregar entidades. <button class="btn btn-ghost btn-sm" type="button" onclick="loadEntities()">Tentar de novo</button></span>';
  }
}

function renderEntitiesEmpty(wrap) {
  wrap.innerHTML = '<span class="muted" style="font-size:13px">Nenhuma entidade extraída ainda. Execute um reindex para começar.</span>';
}

function renderEntities(wrap, entities) {
  if (!entities || entities.length === 0) { renderEntitiesEmpty(wrap); return; }

  var TYPES = ['pessoa', 'empresa', 'projeto'];
  var TYPE_LABEL_E = { pessoa: 'Pessoas', empresa: 'Empresas', projeto: 'Projetos' };

  // Apply entity search filter when active
  var q = entityState.entityQ ? entityState.entityQ.toLowerCase() : '';
  var filtered = q ? entities.filter(function(e) { return e.name.toLowerCase().includes(q); }) : entities;

  var html = TYPES.map(function(type) {
    var items = filtered.filter(function(e) { return e.type === type; });
    if (items.length === 0) return '';
    var SHOW = 10;
    var visible = (entityState.expanded[type] || q) ? items : items.slice(0, SHOW);
    var chips = visible.map(function(e) {
      var active = explorerState.entityIds.has(e.id);
      // Disambiguate: when the same name exists under >1 type, append "· tipo".
      var typeSuffix = isAmbiguousName(e.name)
        ? ' <span class="entity-type">· ' + escapeHtml(TYPE_LABEL_SINGULAR[e.type] || e.type) + '</span>'
        : '';
      return '<button class="fchip entity-chip' + (active ? ' active' : '') + '" type="button" data-testid="entity-chip" data-entity-id="' + e.id + '" data-entity-name="' + escapeHtml(e.name) + '" data-entity-type="' + escapeHtml(e.type) + '">' +
        escapeHtml(e.name) + typeSuffix + ' <span class="cnt">' + e.mention_count + '</span></button>';
    }).join('');
    var moreBtn = (!entityState.expanded[type] && !q && items.length > SHOW)
      ? '<button class="btn btn-ghost btn-sm" style="font-size:12px" type="button" data-expand-type="' + type + '">ver mais (' + (items.length - SHOW) + ')</button>'
      : '';
    var typeCount = entities.filter(function(e) { return e.type === type; }).length;
    var label = TYPE_LABEL_E[type] + (q ? ' (' + items.length + '/' + typeCount + ')' : '');
    return '<div class="entity-group" style="margin-bottom:10px">' +
      '<div class="meta" style="margin-bottom:4px;font-weight:600">' + label + '</div>' +
      '<div class="entity-chips" style="display:flex;flex-wrap:wrap;gap:6px">' + chips + moreBtn + '</div>' +
      '</div>';
  }).join('');

  if (!html) {
    wrap.innerHTML = '<span class="muted" style="font-size:13px">Nenhuma entidade encontrada para "' + escapeHtml(entityState.entityQ) + '".</span>';
  } else {
    wrap.innerHTML = html;
  }

  // Wire click handlers — MULTI-SELECT: toggle adds/removes from Set
  wrap.querySelectorAll('.entity-chip').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.getAttribute('data-entity-id'), 10);
      var name = btn.getAttribute('data-entity-name') || '';
      var type = btn.getAttribute('data-entity-type') || '';
      if (explorerState.entityIds.has(id)) {
        explorerState.entityIds.delete(id);
        delete explorerState.entityNames[id];
        delete explorerState.entityTypes[id];
      } else {
        explorerState.entityIds.add(id);
        explorerState.entityNames[id] = name;
        explorerState.entityTypes[id] = type;
      }
      renderEntities(wrap, _entitiesCache);
      renderExplorerSelection();
      refreshExplorer(true);
    });
  });

  wrap.querySelectorAll('[data-expand-type]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var type = btn.getAttribute('data-expand-type');
      entityState.expanded[type] = true;
      renderEntities(wrap, _entitiesCache);
    });
  });
}

/** Render the selected entity pills and update selection UI visibility. */
function renderExplorerSelection() {
  var selEl = document.getElementById('explorer-selection');
  var pillsEl = document.getElementById('explorer-selection-pills');
  var cntEl = document.getElementById('explorer-sel-count');
  var n = explorerState.entityIds.size;

  if (selEl) selEl.style.display = n > 0 ? 'flex' : 'none';
  if (cntEl) {
    cntEl.style.display = n > 0 ? 'inline' : 'none';
    cntEl.textContent = n + ' selecionada' + (n !== 1 ? 's' : '');
  }

  if (!pillsEl) return;
  pillsEl.innerHTML = Array.from(explorerState.entityIds).map(function(id) {
    var name = explorerState.entityNames[id] || String(id);
    var type = explorerState.entityTypes[id] || '';
    // Show "· tipo" on the pill whenever the name is ambiguous, so a selected
    // "global cripto · empresa" never reads identically to its projeto twin.
    var typeSuffix = (type && isAmbiguousName(name))
      ? '<span class="entity-type">· ' + escapeHtml(TYPE_LABEL_SINGULAR[type] || type) + '</span>'
      : '';
    return '<span class="explorer-pill">' + escapeHtml(name) + typeSuffix +
      ' <button class="explorer-pill-rm" type="button" aria-label="Remover ' + escapeHtml(name) + '" data-remove-id="' + id + '">✕</button></span>';
  }).join('');

  pillsEl.querySelectorAll('[data-remove-id]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.getAttribute('data-remove-id'), 10);
      explorerState.entityIds.delete(id);
      delete explorerState.entityNames[id];
      delete explorerState.entityTypes[id];
      if (_entitiesCache) renderEntities(document.getElementById('entities-block'), _entitiesCache);
      renderExplorerSelection();
      refreshExplorer(true);
    });
  });
}

/* ==================== BRAIN GRAPH (F5, v2 — Cytoscape + fcose) ==================== */

var _cy = null;                  // Cytoscape instance
var _graphMode = 'overview';     // 'overview' | 'focus'
var _graphIncludeDocs = false;   // docs toggle (focus mode only)
var _graphLabelsForced = false;  // toolbar label override
var _graphFocusEntityIds = [];   // entity IDs currently in focus
var _graphLoaded = false;        // true once first overview is rendered
var _graphToolbarWired = false;  // prevent double-wiring
var _graphCurrentNode = null;    // node data of currently selected node

/* ---- colour tokens ---- */
var GC = {
  pessoa:  '#1f8b4c',
  empresa: '#4a7ebb',
  projeto: '#d4a017',
  doc:     '#9e9e9e',
};

/* ---- register fcose once (scripts loaded by app.html) ---- */
var _fcoseRegistered = false;
function ensureFcose() {
  if (_fcoseRegistered) return;
  if (window.cytoscape && window.cytoscapeFcose) {
    try { window.cytoscape.use(window.cytoscapeFcose); } catch (_e) { /* already registered */ }
    _fcoseRegistered = true;
  }
}

/* ---- convert API response to Cytoscape elements ---- */
function toCyElements(data) {
  var els = [];
  (data.nodes || []).forEach(function(n) {
    var color = n.kind === 'entity' ? (GC[n.type] || '#888') : GC.doc;
    var r = n.kind === 'entity'
      ? Math.max(10, Math.min(36, Math.sqrt(n.weight || 1) * 4))
      : Math.max(7, Math.min(22, Math.sqrt(n.weight || 1) * 2.5));
    els.push({ data: {
      id: n.id, kind: n.kind, label: n.label, type: n.type,
      weight: n.weight || 1, url: n.url || null,
      color: color, size: r,
    }});
  });
  (data.edges || []).forEach(function(e) {
    var w = e.weight || 1;
    els.push({ data: {
      id: 'edge-' + e.a + '-' + e.b,
      source: e.a, target: e.b,
      weight: w,
      width: Math.max(0.5, Math.min(4, w * 0.4)),
    }});
  });
  return els;
}

/* ---- build Cytoscape style array ---- */
function cyStyle() {
  return [
    {
      selector: 'node',
      style: {
        'width': 'data(size)',
        'height': 'data(size)',
        'background-color': 'data(color)',
        'border-width': 1,
        'border-color': 'rgba(0,0,0,0.12)',
        'label': '',
        'font-family': '"Geist Mono Variable","Geist Mono",monospace',
        'font-size': '10px',
        'color': '#26241f',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'text-max-width': '100px',
        'text-wrap': 'ellipsis',
        'min-zoomed-font-size': 8,
        'transition-property': 'opacity, border-width',
        'transition-duration': '0.15s',
        'cursor': 'pointer',
      }
    },
    { selector: 'node.show-label', style: { 'label': 'data(label)' } },
    { selector: 'node.dimmed', style: { 'opacity': 0.12 } },
    {
      selector: 'node:selected',
      style: { 'border-width': 3, 'border-color': '#26241f', 'label': 'data(label)', 'opacity': 1 }
    },
    { selector: 'node.highlighted', style: { 'label': 'data(label)', 'opacity': 1 } },
    {
      selector: 'edge',
      style: {
        'width': 'data(width)',
        'line-color': 'rgba(100,90,75,0.18)',
        'curve-style': 'bezier',
        'transition-property': 'opacity, line-color',
        'transition-duration': '0.15s',
      }
    },
    { selector: 'edge.dimmed', style: { 'opacity': 0.05 } },
    { selector: 'edge.highlighted', style: { 'line-color': 'rgba(31,139,76,0.45)', 'opacity': 1 } },
  ];
}

/* ---- apply label classes based on zoom level and global toggle ---- */
function updateLabels() {
  if (!_cy) return;
  var zoom = _cy.zoom();
  _cy.nodes().forEach(function(n) {
    var big = n.data('weight') >= 5;
    var show = _graphLabelsForced || big || zoom > 1.4;
    n.toggleClass('show-label', show && !n.hasClass('dimmed'));
  });
}

/* ---- highlight neighbourhood of a node ---- */
function highlightNode(nodeId) {
  if (!_cy) return;
  if (!nodeId) {
    _cy.elements().removeClass('dimmed highlighted');
    updateLabels();
    return;
  }
  var node = _cy.getElementById(nodeId);
  if (!node || node.empty()) return;
  var neighbors = node.neighborhood().add(node);
  _cy.elements().addClass('dimmed').removeClass('highlighted');
  neighbors.removeClass('dimmed').addClass('highlighted');
  updateLabels();
}

/* ---- init or re-init Cytoscape ---- */
function initCy(data) {
  ensureFcose();
  var container = document.getElementById('brain-graph-cy');
  if (!container) return;

  if (_cy) { _cy.destroy(); _cy = null; }

  var useFcose = _fcoseRegistered;
  var layoutConfig = useFcose
    ? {
        name: 'fcose',
        quality: 'proof',
        animate: true,
        animationDuration: 600,
        randomize: true,
        nodeRepulsion: function() { return 12000; },
        idealEdgeLength: function() { return 90; },
        edgeElasticity: function() { return 0.45; },
        numIter: 2500,
        packComponents: true,
        componentSpacing: 50,
        nodeSeparation: 75,
        gravityRange: 3.8,
        gravity: 0.25,
        tile: true,
        tilingPaddingVertical: 10,
        tilingPaddingHorizontal: 10,
        initialEnergyOnIncremental: 0.5,
        stop: function() { updateLabels(); },
      }
    : {
        name: 'cose',
        animate: true,
        animationDuration: 600,
        nodeRepulsion: function() { return 800000; },
        idealEdgeLength: function() { return 90; },
        componentSpacing: 80,
        gravity: 0.25,
        numIter: 1500,
        stop: function() { updateLabels(); },
      };

  _cy = window.cytoscape({
    container: container,
    elements: toCyElements(data),
    style: cyStyle(),
    layout: layoutConfig,
    minZoom: 0.1,
    maxZoom: 6,
    wheelSensitivity: 0.3,
  });

  _cy.on('zoom', updateLabels);

  // Single click: highlight + open panel
  _cy.on('tap', 'node', function(e) {
    var node = e.target;
    var nodeId = node.id();
    highlightNode(nodeId);
    _cy.animate({ center: { eles: node }, zoom: Math.max(_cy.zoom(), 0.8), duration: 300 });
    _graphCurrentNode = node.data();
    openGraphPanel(node.data());
  });

  // Double-click on entity: focus mode
  _cy.on('dbltap', 'node', function(e) {
    var node = e.target;
    if (node.data('kind') !== 'entity') return;
    var rawId = node.id(); // "e:123"
    var numId = parseInt(rawId.slice(2), 10);
    if (!isNaN(numId)) {
      _graphFocusEntityIds = [numId];
      _graphMode = 'focus';
      reloadGraph({ mode: 'focus', entity_ids: [numId] });
    }
  });

  // Click on background: clear
  _cy.on('tap', function(e) {
    if (e.target === _cy) {
      _cy.elements().removeClass('dimmed highlighted');
      updateLabels();
      var panel = document.getElementById('graph-panel');
      if (panel) panel.classList.remove('open');
      _graphCurrentNode = null;
    }
  });

  _cy.one('layoutstop', function() {
    _cy.fit(_cy.elements(), 40);
    updateLabels();
  });
}

/* ---- fetch graph data and (re)render ---- */
async function reloadGraph(overrideParams) {
  var wrap = document.getElementById('brain-graph-wrap');
  var empty = document.getElementById('brain-graph-empty');
  var hint = document.getElementById('graph-hint');
  if (!wrap || !empty) return;

  var params = new URLSearchParams();
  var mode = (overrideParams && overrideParams.mode) || _graphMode;
  params.set('mode', mode);
  if (overrideParams && overrideParams.entity_ids && overrideParams.entity_ids.length) {
    params.set('entity_ids', overrideParams.entity_ids.join(','));
  }
  if (_graphIncludeDocs && mode === 'focus') params.set('include_docs', 'true');

  try {
    var res = await api('/portal/brain/graph?' + params.toString());
    if (!res.ok) { empty.style.display = 'block'; wrap.style.display = 'none'; return; }
    var data = await res.json();

    if (!data.nodes || data.nodes.length === 0) {
      empty.style.display = 'block'; wrap.style.display = 'none'; return;
    }

    empty.style.display = 'none';
    wrap.style.display = 'block';

    if (hint) {
      if (mode === 'overview') {
        hint.textContent = 'Mostrando as 40 entidades mais conectadas — clique numa para explorar.';
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }
    }

    var docBtn = document.getElementById('graph-btn-docs');
    var clearBtn = document.getElementById('graph-btn-clear');
    var legendDoc = document.getElementById('graph-legend-doc');
    if (docBtn) docBtn.style.display = mode === 'focus' ? '' : 'none';
    if (clearBtn) clearBtn.style.display = mode === 'focus' ? '' : 'none';
    if (legendDoc) legendDoc.style.display = _graphIncludeDocs && mode === 'focus' ? '' : 'none';

    initCy(data);
    _graphLoaded = true;
  } catch (e) {
    empty.style.display = 'block'; wrap.style.display = 'none';
  }
}

/* ---- initial load (called when Grafo tab opens) ---- */
async function loadGraph() {
  if (_graphLoaded) {
    if (_cy) _cy.resize();
    return;
  }
  _graphMode = 'overview';
  await reloadGraph({ mode: 'overview' });
}

/* ---- wire toolbar buttons (called once on first Grafo tab open) ---- */
function wireGraphToolbar() {
  if (_graphToolbarWired) return;
  _graphToolbarWired = true;

  var btnFit = document.getElementById('graph-btn-fit');
  if (btnFit) btnFit.addEventListener('click', function() {
    if (_cy) _cy.animate({ fit: { eles: _cy.elements(), padding: 40 }, duration: 300 });
  });

  var btnZoomIn = document.getElementById('graph-btn-zoom-in');
  if (btnZoomIn) btnZoomIn.addEventListener('click', function() {
    if (_cy) _cy.animate({ zoom: Math.min(_cy.zoom() * 1.3, 6), duration: 200 });
  });

  var btnZoomOut = document.getElementById('graph-btn-zoom-out');
  if (btnZoomOut) btnZoomOut.addEventListener('click', function() {
    if (_cy) _cy.animate({ zoom: Math.max(_cy.zoom() * 0.77, 0.1), duration: 200 });
  });

  var btnLabels = document.getElementById('graph-btn-labels');
  if (btnLabels) btnLabels.addEventListener('click', function() {
    _graphLabelsForced = !_graphLabelsForced;
    btnLabels.setAttribute('aria-pressed', String(_graphLabelsForced));
    updateLabels();
  });

  var btnDocs = document.getElementById('graph-btn-docs');
  if (btnDocs) btnDocs.addEventListener('click', function() {
    _graphIncludeDocs = !_graphIncludeDocs;
    btnDocs.setAttribute('aria-pressed', String(_graphIncludeDocs));
    if (_graphMode === 'focus' && _graphFocusEntityIds.length > 0) {
      reloadGraph({ mode: 'focus', entity_ids: _graphFocusEntityIds });
    }
  });

  var btnClear = document.getElementById('graph-btn-clear');
  if (btnClear) btnClear.addEventListener('click', function() {
    _graphMode = 'overview';
    _graphFocusEntityIds = [];
    _graphIncludeDocs = false;
    _graphLoaded = false; // force reload
    var panel = document.getElementById('graph-panel');
    if (panel) panel.classList.remove('open');
    reloadGraph({ mode: 'overview' });
  });

  var panelClose = document.getElementById('graph-panel-close');
  if (panelClose) panelClose.addEventListener('click', function() {
    var panel = document.getElementById('graph-panel');
    if (panel) panel.classList.remove('open');
    if (_cy) { _cy.elements().removeClass('dimmed highlighted'); updateLabels(); }
    _graphCurrentNode = null;
  });

  // Rename button
  var renameBtn = document.getElementById('graph-panel-rename-btn');
  var renameForm = document.getElementById('graph-panel-rename-form');
  var renameInput = document.getElementById('graph-panel-rename-input');
  var renameSave = document.getElementById('graph-panel-rename-save');
  var renameCancel = document.getElementById('graph-panel-rename-cancel');
  if (renameBtn) renameBtn.addEventListener('click', function() {
    if (!_graphCurrentNode) return;
    renameForm.style.display = 'block';
    renameInput.value = _graphCurrentNode.label;
    renameInput.focus();
  });
  if (renameCancel) renameCancel.addEventListener('click', function() {
    renameForm.style.display = 'none';
  });
  if (renameSave) renameSave.addEventListener('click', async function() {
    if (!_graphCurrentNode) return;
    var newName = renameInput.value.trim();
    if (!newName) return;
    var entityId = parseInt(_graphCurrentNode.id.slice(2), 10);
    try {
      var r = await api('/portal/brain/entities/' + entityId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!r.ok) { alert('Erro ao renomear entidade.'); return; }
      renameForm.style.display = 'none';
      _graphLoaded = false;
      reloadGraph({ mode: _graphMode, entity_ids: _graphFocusEntityIds.length ? _graphFocusEntityIds : undefined });
    } catch(e) { alert('Erro ao renomear entidade.'); }
  });

  // Merge button
  var mergeBtn = document.getElementById('graph-panel-merge-btn');
  var mergeForm = document.getElementById('graph-panel-merge-form');
  var mergeSearch = document.getElementById('graph-panel-merge-search');
  var mergeResults = document.getElementById('graph-panel-merge-results');
  var mergeConfirm = document.getElementById('graph-panel-merge-confirm');
  var mergeConfirmName = document.getElementById('graph-panel-merge-confirm-name');
  var mergeConfirmKeep = document.getElementById('graph-panel-merge-confirm-keep');
  var mergeOk = document.getElementById('graph-panel-merge-ok');
  var mergeCancel = document.getElementById('graph-panel-merge-cancel');
  var _mergeTarget = null; // { id, name }

  if (mergeBtn) mergeBtn.addEventListener('click', function() {
    if (!_graphCurrentNode) return;
    mergeForm.style.display = 'block';
    mergeConfirm.style.display = 'none';
    mergeResults.innerHTML = '';
    mergeSearch.value = '';
    mergeSearch.focus();
  });

  if (mergeSearch) {
    var _mergeDebounce = null;
    mergeSearch.addEventListener('input', function() {
      clearTimeout(_mergeDebounce);
      _mergeDebounce = setTimeout(async function() {
        var q = mergeSearch.value.trim();
        if (!q) { mergeResults.innerHTML = ''; return; }
        try {
          var r = await api('/portal/brain/entities?q=' + encodeURIComponent(q) + '&limit=8');
          if (!r.ok) return;
          var d = await r.json();
          mergeResults.innerHTML = '';
          (d.entities || []).forEach(function(ent) {
            if (_graphCurrentNode && ent.id === parseInt(_graphCurrentNode.id.slice(2), 10)) return;
            var item = document.createElement('div');
            item.className = 'graph-merge-result';
            item.textContent = ent.name + ' (' + ent.type + ')';
            item.addEventListener('click', function() {
              _mergeTarget = ent;
              mergeConfirmName.textContent = ent.name;
              mergeConfirmKeep.textContent = _graphCurrentNode ? _graphCurrentNode.label : '';
              mergeConfirm.style.display = 'block';
              mergeResults.innerHTML = '';
            });
            mergeResults.appendChild(item);
          });
        } catch(e) {}
      }, 300);
    });
  }

  if (mergeCancel) mergeCancel.addEventListener('click', function() {
    mergeForm.style.display = 'none';
    mergeConfirm.style.display = 'none';
    _mergeTarget = null;
  });

  if (mergeOk) mergeOk.addEventListener('click', async function() {
    if (!_graphCurrentNode || !_mergeTarget) return;
    var keepId = parseInt(_graphCurrentNode.id.slice(2), 10);
    var mergeId = _mergeTarget.id;
    try {
      var r = await api('/portal/brain/entities/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_id: keepId, merge_id: mergeId }),
      });
      if (!r.ok) { alert('Erro ao mesclar entidades.'); return; }
      mergeForm.style.display = 'none';
      mergeConfirm.style.display = 'none';
      _mergeTarget = null;
      var panel = document.getElementById('graph-panel');
      if (panel) panel.classList.remove('open');
      _graphCurrentNode = null;
      _graphLoaded = false;
      reloadGraph({ mode: _graphMode, entity_ids: _graphFocusEntityIds.length ? _graphFocusEntityIds : undefined });
    } catch(e) { alert('Erro ao mesclar entidades.'); }
  });
}

/* ---- open the side panel for a clicked node ---- */
function openGraphPanel(nodeData) {
  var panel = document.getElementById('graph-panel');
  var nameEl = document.getElementById('graph-panel-name');
  var metaEl = document.getElementById('graph-panel-meta');
  var docsBtn = document.getElementById('graph-panel-docs');
  var focusBtn = document.getElementById('graph-panel-focus');
  var renameBtn = document.getElementById('graph-panel-rename-btn');
  var mergeBtn = document.getElementById('graph-panel-merge-btn');
  var renameForm = document.getElementById('graph-panel-rename-form');
  var mergeForm = document.getElementById('graph-panel-merge-form');
  if (!panel) return;
  if (!nodeData) { panel.classList.remove('open'); return; }

  // Reset inline forms
  if (renameForm) renameForm.style.display = 'none';
  if (mergeForm) mergeForm.style.display = 'none';

  panel.classList.add('open');
  nameEl.textContent = nodeData.label;

  if (nodeData.kind === 'entity') {
    var TYPE_PT = { pessoa: 'Pessoa', empresa: 'Empresa', projeto: 'Projeto' };
    metaEl.textContent = (TYPE_PT[nodeData.type] || nodeData.type) + ' · ' + nodeData.weight + ' menções';

    if (focusBtn) {
      focusBtn.style.display = '';
      focusBtn.textContent = 'Explorar vizinhança →';
      focusBtn.onclick = function() {
        var numId = parseInt(nodeData.id.slice(2), 10);
        if (!isNaN(numId)) {
          _graphMode = 'focus';
          _graphFocusEntityIds = [numId];
          reloadGraph({ mode: 'focus', entity_ids: [numId] });
          panel.classList.remove('open');
        }
      };
    }

    if (docsBtn) {
      docsBtn.style.display = '';
      docsBtn.textContent = 'Ver documentos →';
      docsBtn.onclick = function() {
        var id = parseInt(nodeData.id.slice(2), 10);
        explorerState.entityIds = new Set([id]);
        explorerState.entityNames[id] = nodeData.label;
        explorerState.entityTypes[id] = nodeData.type || '';
        if (_entitiesCache) renderEntities(document.getElementById('entities-block'), _entitiesCache);
        renderExplorerSelection();
        switchBrainView('lista');
        refreshExplorer(true);
      };
    }

    if (renameBtn) renameBtn.style.display = '';
    if (mergeBtn) mergeBtn.style.display = '';
  } else {
    // doc node
    metaEl.textContent = (nodeData.type || '') + ' · ' + nodeData.weight + ' menções';
    if (focusBtn) focusBtn.style.display = 'none';
    if (renameBtn) renameBtn.style.display = 'none';
    if (mergeBtn) mergeBtn.style.display = 'none';
    if (docsBtn) {
      if (nodeData.url) {
        docsBtn.style.display = '';
        docsBtn.textContent = 'Abrir documento →';
        docsBtn.onclick = function() { window.open(nodeData.url, '_blank', 'noopener'); };
      } else {
        docsBtn.style.display = 'none';
      }
    }
  }
}

/** Switch between Lista and Grafo views. Filters are preserved across switches. */
function switchBrainView(view) {
  var listaEl = document.getElementById('brain-lista-view');
  var grafoEl = document.getElementById('brain-grafo-view');
  var btnLista = document.getElementById('brain-toggle-lista');
  var btnGrafo = document.getElementById('brain-toggle-grafo');
  if (!listaEl || !grafoEl) return;

  explorerState.view = view;

  if (view === 'grafo') {
    listaEl.style.display = 'none';
    grafoEl.style.display = 'block';
    if (btnLista) btnLista.classList.remove('active');
    if (btnGrafo) btnGrafo.classList.add('active');
    wireGraphToolbar(); // idempotent, wires toolbar + panel buttons once
    loadGraph();
  } else {
    grafoEl.style.display = 'none';
    listaEl.style.display = 'block';
    if (btnLista) btnLista.classList.add('active');
    if (btnGrafo) btnGrafo.classList.remove('active');
  }
}

/* ==================== ATIVIDADE ====================  */

/**
 * Unified explorer state.
 * - entityIds: Set of selected entity IDs (multi-select)
 * - entityNames: map id -> name (for pill labels)
 * - match: 'all' | 'any'
 * - sourceType: 'all' | 'notion' | 'granola' | 'calendar' | 'web'
 * - q: text search
 * - view: 'lista' | 'grafo'
 * - offset: pagination
 */
var explorerState = {
  entityIds: new Set(),
  entityNames: {},
  entityTypes: {},   // id -> 'pessoa'|'empresa'|'projeto' (for type-disambiguated pills)
  match: 'all',
  sourceType: 'all',
  q: '',
  view: 'lista',
  offset: 0,
};

// COMPAT: docState alias (old code may reference docState.filter, docState.entityId)
var docState = {
  get filter() { return explorerState.sourceType; },
  set filter(v) { explorerState.sourceType = v; },
  get q() { return explorerState.q; },
  set q(v) { explorerState.q = v; },
  get offset() { return explorerState.offset; },
  set offset(v) { explorerState.offset = v; },
  get entityId() { return explorerState.entityIds.size === 1 ? explorerState.entityIds.values().next().value : undefined; },
  set entityId(v) {
    if (v === undefined || v === null) { explorerState.entityIds.clear(); }
    else { explorerState.entityIds.add(v); }
  },
};

var PAGE = 50;
var statusPollTimer = null;
/* E2.3: last counts from /portal/status for filter button rendering */
var _lastStatusCounts = null;

function stopStatusPolling() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

async function loadStatus() {
  var st;
  try {
    var res = await api('/portal/status');
    if (!res.ok) return;
    st = await res.json();
  } catch (e) { return; }

  var busy = !!st.running;
  renderBrainMini(busy, st);

  /* E2.3: cache counts for filter button rendering */
  _lastStatusCounts = st.counts || null;

  /* Fix "Tudo 0": /portal/status resolves AFTER the first loadBrain(true), so the
   * filter chips were rendered with empty counts. Now that fresh counts are in,
   * re-render the source filter chips (cheap, idempotent, preserves active state). */
  if (explorerState.view === 'lista') refreshDocFilters();

  /* indexing-tag */
  var itag = document.getElementById('indexing-tag');
  if (itag) itag.classList.toggle('hidden', !busy);

  /* stat-strip */
  var totals = (st.counts && st.counts.totals) || {};
  var ss = document.getElementById('stat-strip');
  if (ss) {
    var bySource = (st.counts && st.counts.bySource) || [];
    var nSrcActive = bySource.filter(function (s) { return s.documents > 0; }).length;
    var lastAt2 = bySource.reduce(function (m, s) {
      return s.last_indexed_at && s.last_indexed_at > m ? s.last_indexed_at : m;
    }, '');
    var lastStr = lastAt2 ? new Date(lastAt2).toLocaleString('pt-BR') : 'nunca';
    ss.innerHTML =
      '<div class="stat"><div class="v">' + fmt(totals.documents || 0) + '</div><div class="k">documentos</div></div>' +
      '<div class="stat"><div class="v">' + fmt(totals.chunks || 0) + '</div><div class="k">trechos</div></div>' +
      '<div class="stat"><div class="v">' + nSrcActive + '</div><div class="k">fontes ativas</div></div>' +
      '<div class="stat"><div class="v" style="font-size:15px;padding-top:5px">' + escapeHtml(lastStr) + '</div><div class="k">ultima indexacao</div></div>';
  }

  /* por fonte — E2.1: enriched ActivitySource list from backend */
  var srcStatus = document.getElementById('src-status');
  if (srcStatus) {
    var ESTADO_LABEL = {
      aguardando_primeira_indexacao: 'aguardando',
      indexando: 'indexando',
      ok: 'ok',
      erro: 'erro',
      indisponivel_no_plano: 'plano',
      pulado_sem_credencial: 'sem credencial'
    };
    var ESTADO_TAG = {
      aguardando_primeira_indexacao: 'warn',
      indexando: 'warn',
      ok: 'ok',
      erro: 'off',
      indisponivel_no_plano: 'off',
      pulado_sem_credencial: 'warn'
    };
    var sources = st.sources || [];
    if (sources.length === 0) {
      srcStatus.innerHTML = '<p class="muted" style="padding:12px 0">Nenhuma fonte conectada ainda. Configure em Fontes.</p>';
    } else {
      srcStatus.innerHTML = sources.map(function (s) {
        var t = s.source_type || (s.source && s.source.startsWith('notion') ? 'notion'
          : s.source && s.source.startsWith('granola') ? 'granola'
          : s.source && s.source.startsWith('calendar') ? 'calendar' : 'web');
        /* counts: prefer ActivitySource shape (counts blob); fall back to bySource totals */
        var bySrc = (st.counts && st.counts.bySource || []).find(function (b) { return b.source_type === t; }) || {};
        var cts = s.counts && typeof s.counts === 'object' ? s.counts : null;
        var docsN = (cts && cts.documents != null) ? cts.documents : (bySrc.documents || 0);
        var chunksN = (cts && cts.chunks != null) ? cts.chunks : (bySrc.chunks || 0);
        var estado = s.estado || (s.ok === false ? 'erro' : (s.last_run ? 'ok' : 'aguardando_primeira_indexacao'));
        var tagCls = ESTADO_TAG[estado] || 'warn';
        var tagLbl = ESTADO_LABEL[estado] || estado;
        var displayName = s.display_name || s.source || t;
        /* error: expandable when present */
        var errHtml = '';
        if (estado === 'erro' && s.error) {
          errHtml = '<details style="margin-top:4px"><summary class="meta" style="color:var(--bad);cursor:pointer">⚠ ver erro</summary>' +
            '<span class="meta" style="color:var(--bad);display:block;margin-top:4px;word-break:break-word">' + escapeHtml(s.error) + '</span></details>';
        }
        var when = (estado === 'ok' && s.last_run) ? '<span class="meta">sincronizado ' + new Date(s.last_run).toLocaleString('pt-BR') + '</span>' : '';
        return '<div class="row">' + srcIcon(t) +
          '<span class="grow"><span class="ttl">' + escapeHtml(displayName) + '</span>' +
          (errHtml || when) + '</span>' +
          '<span class="nums">' + fmt(docsN) + ' docs<br>' + fmt(chunksN) + ' trechos</span>' +
          '<span class="tag ' + tagCls + '">' + escapeHtml(tagLbl) + '</span>' +
          '</div>';
      }).join('');
    }
  }

  /* poll */
  if (busy) {
    if (!statusPollTimer) statusPollTimer = setInterval(loadStatus, 4000);
  } else if (statusPollTimer) {
    stopStatusPolling();
    load();
    loadBilling();
  }
}

/* ---- navegador de documentos ---- */
/**
 * Derive {countsByType, total} from the cached /portal/status counts.
 * Normalizes the gcal source_type into calendar and folds any other
 * source_type into the total so "Tudo" reflects every indexed document.
 */
function deriveFilterCounts() {
  var bySrc = (_lastStatusCounts && _lastStatusCounts.bySource) || [];
  var countsByType = {};
  var total = 0;
  bySrc.forEach(function (b) {
    var t = b.source_type === 'gcal' ? 'calendar' : b.source_type;
    var n = b.documents || 0;
    countsByType[t] = (countsByType[t] || 0) + n;
    total += n;
  });
  return { countsByType: countsByType, total: total };
}

function renderDocFilters(countsByType, total) {
  var el = document.getElementById('doc-filters');
  if (!el) return;
  var types = ['all', 'notion', 'granola', 'calendar', 'web'].filter(function (t) {
    return t === 'all' || countsByType[t];
  });
  el.innerHTML = types.map(function (t) {
    var lbl = t === 'all' ? 'Tudo' : (TYPE_LABEL[t] || t);
    var cnt = t === 'all' ? total : (countsByType[t] || 0);
    return '<button class="fchip' + (explorerState.sourceType === t ? ' active' : '') + '" type="button" data-filter="' + t + '">' +
      lbl + ' <span class="cnt">' + cnt + '</span></button>';
  }).join('');
}

/** Re-render the source filter chips from the latest cached status counts.
 *  Called both on explorer reset and whenever /portal/status resolves, so the
 *  "Tudo N" total is never stuck at 0 due to init ordering (status resolves
 *  after the first loadBrain). */
function refreshDocFilters() {
  var c = deriveFilterCounts();
  renderDocFilters(c.countsByType, c.total);
}

/**
 * refreshExplorer: central refresh that updates BOTH lista and grafo
 * based on current explorerState. When view=lista, loads documents.
 * When view=grafo, refreshes graph. Always refreshes the other lazily.
 */
function refreshExplorer(reset) {
  if (explorerState.view === 'grafo') {
    loadGraph();
  } else {
    loadBrain(reset);
  }
}

async function loadBrain(reset) {
  if (reset) {
    explorerState.offset = 0;
    /* E2.3: restore filter buttons above search using cached counts from /portal/status */
    refreshDocFilters();
  }
  var params = new URLSearchParams();
  if (explorerState.q) params.set('q', explorerState.q);
  if (explorerState.sourceType !== 'all') params.set('source_type', explorerState.sourceType);
  // Multi-entity filter: send entity_ids CSV + match
  if (explorerState.entityIds.size > 0) {
    params.set('entity_ids', Array.from(explorerState.entityIds).join(','));
    params.set('match', explorerState.match);
  }
  params.set('limit', String(PAGE));
  params.set('offset', String(explorerState.offset));
  var docs = [];
  try {
    var res = await api('/portal/brain/documents?' + params.toString());
    if (res.ok) docs = (await res.json()).documents || [];
  } catch (e) { /* ignore */ }

  var wrap = document.getElementById('doc-list');
  var emptyEl = document.getElementById('doc-empty');
  var emptyHint = document.getElementById('doc-empty-hint');
  if (reset && wrap) wrap.innerHTML = '';

  if (reset && docs.length === 0) {
    // Show appropriate empty state
    if (emptyEl) {
      emptyEl.classList.remove('hidden');
      // Hint: suggest switching to 'any' when match=all and entities selected
      if (emptyHint) {
        var showHint = explorerState.entityIds.size > 1 && explorerState.match === 'all';
        emptyHint.style.display = showHint ? 'block' : 'none';
      }
    }
    if (!explorerState.entityIds.size && wrap) {
      wrap.innerHTML = '<p class="muted" style="padding:18px 2px">Nada por aqui ainda. Conecte fontes e indexe, ou ajuste o filtro.</p>';
    }
  } else {
    if (emptyEl) emptyEl.classList.add('hidden');
  }

  for (var d of docs) {
    var title = d.title || '(sem titulo)';
    var inner = (d.parent_url && isHttpUrl(d.parent_url))
      ? '<a class="ttl" href="' + escapeHtml(d.parent_url) + '" target="_blank" rel="noopener">' + escapeHtml(title) + '</a>'
      : '<span class="ttl">' + escapeHtml(title) + '</span>';
    var date = d.doc_date ? ' · ' + escapeHtml(d.doc_date) : '';
    var row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = srcIcon(d.source_type || 'web') +
      '<span class="grow">' + inner + '</span>' +
      '<span class="meta" style="white-space:nowrap">' + date + escapeHtml(d.db_name || TYPE_LABEL[d.source_type] || '') + '</span>';
    if (wrap) wrap.appendChild(row);
  }
  explorerState.offset += docs.length;

  var pager = document.getElementById('doc-pager');
  var pagerMore = document.getElementById('pager-next');
  var pagerInfo = document.getElementById('pager-info');
  if (pager) pager.classList.toggle('hidden', docs.length < PAGE);
  if (pagerMore) pagerMore.disabled = docs.length < PAGE;
  if (pagerInfo) pagerInfo.textContent = explorerState.offset ? explorerState.offset + ' documentos' : '';
}

var brainQTimer = null;

function wireAtividade() {
  var docFilters = document.getElementById('doc-filters');
  if (docFilters) {
    docFilters.addEventListener('click', function (e) {
      var b = e.target.closest('[data-filter]');
      if (!b) return;
      explorerState.sourceType = b.getAttribute('data-filter');
      refreshExplorer(true);
    });
  }
  var docSearch = document.getElementById('doc-search');
  if (docSearch) {
    docSearch.addEventListener('input', function (e) {
      explorerState.q = e.target.value.trim();
      clearTimeout(brainQTimer);
      brainQTimer = setTimeout(function () { refreshExplorer(true); }, 300);
    });
  }
  var pagerPrev = document.getElementById('pager-prev');
  if (pagerPrev) pagerPrev.addEventListener('click', function () { /* não usado — modo scroll */ });
  var pagerNext = document.getElementById('pager-next');
  if (pagerNext) pagerNext.addEventListener('click', function () { loadBrain(false); });

  // Brain view toggle (Lista | Grafo) — filters are preserved
  var toggleLista = document.getElementById('brain-toggle-lista');
  var toggleGrafo = document.getElementById('brain-toggle-grafo');
  if (toggleLista) toggleLista.addEventListener('click', function() { switchBrainView('lista'); });
  if (toggleGrafo) toggleGrafo.addEventListener('click', function() { switchBrainView('grafo'); });

  // Match toggle (Todas | Qualquer)
  var matchAllBtn = document.getElementById('match-all-btn');
  var matchAnyBtn = document.getElementById('match-any-btn');
  if (matchAllBtn) matchAllBtn.addEventListener('click', function() {
    explorerState.match = 'all';
    matchAllBtn.classList.add('active');
    if (matchAnyBtn) matchAnyBtn.classList.remove('active');
    refreshExplorer(true);
  });
  if (matchAnyBtn) matchAnyBtn.addEventListener('click', function() {
    explorerState.match = 'any';
    matchAnyBtn.classList.add('active');
    if (matchAllBtn) matchAllBtn.classList.remove('active');
    refreshExplorer(true);
  });

  // Entity search input (filters entity chips when >30 entities)
  var entitySearchInput = document.getElementById('entity-search');
  if (entitySearchInput) {
    entitySearchInput.addEventListener('input', function(e) {
      entityState.entityQ = e.target.value.trim();
      if (_entitiesCache) renderEntities(document.getElementById('entities-block'), _entitiesCache);
    });
  }

  // Graph side panel close is now wired in wireGraphToolbar() (called from switchBrainView).

  // Load entities block on Atividade tab open
  loadEntities();
}

/* ==================== CHECKLIST DE ATIVACAO ====================  */

var ACT_STEPS = [
  { label: 'Entrar com seu convite', go: null, goLabel: '' },
  { label: 'Conectar sua primeira fonte', go: 'fontes', goLabel: 'ir para Fontes →' },
  { label: 'Tarefas no Notion', go: null, goLabel: 'configurar →' },
  { label: 'Conectar seu assistente (Claude, ChatGPT…)', go: 'inicio', goLabel: 'conectar →' }
];

var _actDone = [true, false, false, false];
var _actNotionConnected = false;
var _actTasksDone = false;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadActivation(sources) {
  try {
    var res = await api('/portal/activation');
    if (!res.ok) return;
    var st = await res.json();
    var wrap = document.getElementById('activation');
    if (!wrap) return;
    if (st.complete) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    _actNotionConnected = !!(sources && sources.notion && sources.notion.connected);
    _actTasksDone = !!(st.items && st.items.tasks);
    /* mapear os itens do backend (tasks, granola, ical, ask) para os 4 passos */
    _actDone = [
      true, /* convite = sempre feito */
      _actNotionConnected,
      _actTasksDone,
      !!(st.items && st.items.ask)
    ];
    renderActivation();
  } catch (e) { /* ignore */ }
}

function renderActivation() {
  var wrap = document.getElementById('activation');
  if (!wrap) return;
  var n = _actDone.filter(Boolean).length;
  wrap.classList.toggle('hidden', n === 4);
  var progEl = document.getElementById('activation-prog');
  if (progEl) progEl.textContent = n + '/4';
  var logoEl = document.getElementById('activation-logo');
  if (logoEl) logoEl.innerHTML = logoSvg(18);
  var stepsEl = document.getElementById('activation-steps');
  if (!stepsEl) return;

  var html = ACT_STEPS.map(function (st, i) {
    var isTasksStep = (i === 2);
    /* Para o passo Tarefas incompleto, não exibir goLabel (o sub-fluxo inline substitui) */
    var goLabel = (isTasksStep && !_actDone[i]) ? '' : st.goLabel;
    var btn = '<button class="act-step' + (_actDone[i] ? ' done' : '') + '" type="button" data-step="' + i + '">' +
      '<span class="ck">' + (_actDone[i] ? '✓' : '') + '</span>' +
      '<span>' + st.label + '</span>' +
      '<span class="go">' + goLabel + '</span></button>';

    /* Sub-fluxo inline de Tarefas: aparece apenas quando passo 2 incompleto */
    if (isTasksStep && !_actDone[i]) {
      var inner = '';
      if (!_actNotionConnected) {
        inner = '<p class="muted" style="margin:0 0 0 28px;font-size:13px">Conecte seu Notion em Fontes primeiro.</p>';
      } else {
        inner = '<div style="margin:6px 0 2px 28px;display:flex;flex-direction:column;gap:6px">' +
          '<p class="muted" id="act-tasks-msg" style="margin:0;font-size:13px">Vou procurar (ou criar) uma base de Tarefas no seu Notion.</p>' +
          '<div id="act-tasks-actions" style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-ghost btn-sm" type="button" id="act-tasks-detect-btn">Detectar minha base de Tarefas</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" id="act-tasks-create-btn">Criar base de Tarefas para mim</button>' +
          '</div>' +
        '</div>';
      }
      btn += inner;
    }
    return btn;
  }).join('');

  stepsEl.innerHTML = html + '<p class="muted" style="font-size:12px;margin:10px 0 0;padding-top:8px;border-top:1px solid var(--line)">Dúvida de como usar? <button class="link-quiet" type="button" data-nav="guia" style="font-size:12px">Entenda como usar no Guia →</button></p>';

  /* Wiring dos botoes do sub-fluxo de Tarefas (existem apenas quando step 2 incompleto e notion conectado) */
  var detectBtn = document.getElementById('act-tasks-detect-btn');
  if (detectBtn) detectBtn.addEventListener('click', function (e) { e.stopPropagation(); runDetectTasks(); });
  var createBtn = document.getElementById('act-tasks-create-btn');
  if (createBtn) createBtn.addEventListener('click', function (e) { e.stopPropagation(); runCreateTasks(); });
}

/* ==================== PLANO ====================  */

async function loadBilling() {
  var planEl = document.getElementById('billing-plan');
  var lineEl = document.getElementById('billing-usage-line');
  try {
    var res = await api('/portal/billing');
    if (!res.ok) throw new Error('falha');
    var b = await res.json();
    window._lastBilling = b;
    var PLAN_LABELS = { free: 'Free', essencial: 'Essencial', pro: 'Pro', ilimitado: 'Ilimitado', owner: 'Owner' };
    var status = b.plan_status && b.plan_status !== 'active' ? ' (' + b.plan_status + ')' : '';
    if (planEl) planEl.textContent = (PLAN_LABELS[b.plan] || b.plan || '—') + status;
    var lim = function (v) { return (v == null || !isFinite(v)) ? 'ilimitado' : fmt(v); };
    var sc = b.usage && b.usage.searches;
    var ch = b.usage && b.usage.chunks;
    if (lineEl && sc && ch) {
      lineEl.textContent = 'Consultas este mes: ' + sc.used + '/' + lim(sc.limit) + ' · Trechos indexados: ' + ch.used + '/' + lim(ch.limit);
    }
  } catch (e) {
    if (planEl) planEl.textContent = '—';
  }
}

/* ==================== INDEXACAO ====================  */

var indexing = false;

async function runIndex() {
  if (indexing) return;
  indexing = true;
  var btn = document.getElementById('reindex-btn');
  var bar = document.getElementById('index-progress-bar');
  var subEl = document.getElementById('index-sub');
  var itag = document.getElementById('indexing-tag');
  var stepEl = document.getElementById('index-step');
  var pctEl = document.getElementById('index-pct');
  var fillEl = document.getElementById('index-bar-fill');

  if (btn) btn.disabled = true;
  if (bar) bar.classList.remove('hidden');
  if (subEl) subEl.classList.add('hidden');
  if (itag) itag.classList.remove('hidden');
  renderBrainMini(true, null);

  var res;
  try {
    res = await api('/portal/reindex', { method: 'POST' });
  } catch (e) {
    toast('Erro de rede ao iniciar indexacao.');
    indexing = false;
    if (btn) btn.disabled = false;
    return;
  }

  if (!res.ok) {
    toast('Indexacao indisponivel neste ambiente.');
    indexing = false;
    if (btn) btn.disabled = false;
    if (bar) bar.classList.add('hidden');
    if (subEl) subEl.classList.remove('hidden');
    if (itag) itag.classList.add('hidden');
    renderBrainMini(false, null);
    return;
  }

  toast('Indexacao iniciada — acompanhe em Atividade.');
  /* progresso simulado enquanto o servidor processa */
  var steps = [
    ['Lendo Notion…', 18], ['Lendo reunioes do Granola…', 42],
    ['Lendo agendas…', 58], ['Gerando embeddings…', 86], ['Pronto', 100]
  ];
  var si = 0;
  function tick() {
    var st = steps[si];
    if (stepEl) stepEl.textContent = st[0];
    if (pctEl) pctEl.textContent = st[1] + '%';
    if (fillEl) fillEl.style.width = st[1] + '%';
    si++;
    if (si < steps.length) { setTimeout(tick, 1100); return; }
    setTimeout(function () {
      indexing = false;
      if (btn) btn.disabled = false;
      if (bar) bar.classList.add('hidden');
      if (subEl) subEl.classList.remove('hidden');
      if (itag) itag.classList.add('hidden');
      /* recarregar status e dados */
      loadStatus();
      load();
      loadBilling();
    }, 900);
  }
  tick();
}

/* ==================== JANELA CLAUDE.AI ====================  */

var connectTimer = null;

function wireConnectWindow() {
  var btn = document.getElementById('connect-window-btn');
  var statusEl = document.getElementById('connect-window-status');
  if (!btn || !statusEl) return;

  btn.addEventListener('click', async function () {
    if (connectTimer) return;
    statusEl.textContent = 'Liberando…';
    var res;
    try {
      res = await apiJSON('/portal/connect-window', 'POST');
    } catch (e) { statusEl.textContent = 'Erro de rede. Tente de novo.'; return; }
    var b = await res.json().catch(function () { return {}; });
    if (!res.ok) { statusEl.textContent = b.error || 'Nao consegui liberar agora. Tente de novo.'; return; }
    btn.disabled = true;
    var until = new Date(b.open_until).getTime();
    var tick = function () {
      var left = Math.max(0, Math.round((until - Date.now()) / 1000));
      if (left <= 0) {
        clearInterval(connectTimer); connectTimer = null;
        statusEl.textContent = 'Janela expirou — clique de novo se precisar.';
        btn.disabled = false;
        return;
      }
      var m = Math.floor(left / 60), s = String(left % 60).padStart(2, '0');
      statusEl.textContent = 'Liberado — adicione o conector no Claude.ai agora (' + m + ':' + s + ')';
    };
    tick();
    connectTimer = setInterval(tick, 1000);
    toast('Conexao liberada por 5 minutos — agora adicione o conector no Claude.ai');
  });
}

/* ==================== TOKEN MCP ====================  */

async function generateToken() {
  var res;
  try {
    res = await apiJSON('/portal/mcp-token', 'POST');
  } catch (e) { toast('Erro de rede ao gerar token.'); return; }
  if (!res.ok) { toast('Nao consegui gerar o token.'); return; }
  var data = await res.json();
  var token = data.token;
  var mcpUrl = data.mcp_url || 'https://zinom.ai/mcp';
  var cmd = 'claude mcp add --transport http zinom \\\n  ' + mcpUrl + ' \\\n  --header "Authorization: Bearer ' + token + '"';
  var area = document.getElementById('token-area');
  if (area) {
    area.innerHTML =
      '<div class="token-reveal">' +
      '<div class="meter-head" style="margin-bottom:7px"><strong>Seu token pessoal</strong><span class="tag warn">aparece so uma vez</span></div>' +
      '<div class="tk">' + escapeHtml(token) + '</div>' +
      '<button class="btn btn-ghost btn-sm mt-sm" type="button" data-copy-token="' + escapeHtml(token) + '">Copiar token</button>' +
      '</div>' +
      '<label class="mt-md">Claude Code — cole no terminal:</label>' +
      '<div class="code-block">' + escapeHtml(cmd).replace('claude', '<span class="hl">claude</span>') +
      '<button class="copy-btn" type="button" data-copy="' + escapeHtml(cmd.replace(/\n/g, ' ').replace(/\\ /g, '')) + '">copiar</button></div>' +
      '<p class="muted mt-sm">Outros clientes MCP (Cursor etc.): use o endereco acima com o cabecalho <code>Authorization: Bearer &lt;token&gt;</code>.</p>';
  }
  var genBtn = document.getElementById('token-gen-btn');
  if (genBtn) genBtn.textContent = 'Gerar novo token';
  /* recarregar lista de tokens */
  await loadMcpTokens();
  renderInicio(window._lastMe, window._lastBilling);
}

/* ==================== CHAT DE TESTE ====================  */

var chatBusy = false;
// E3: histórico de conversa (últimas 6 mensagens, gerenciado no cliente)
var chatHistory = [];
var SUGGESTIONS_DATA = [
  { type: 'granola', text: 'O que ficou decidido na ultima reuniao do time?' },
  { type: 'calendar', text: 'O que tenho na agenda esta semana?' },
  { type: 'notion', text: 'Resuma os meus projetos em andamento' }
];

function renderChatEmpty(me) {
  var logoEl = document.getElementById('empty-logo');
  if (logoEl) logoEl.innerHTML = logoSvg(46);
  var statsEl = document.getElementById('empty-stats');
  if (statsEl && me) {
    /* pegar totais do /portal/status se disponivel; senao omite */
    statsEl.innerHTML = '';
  }
  var suggEl = document.getElementById('suggestions');
  if (suggEl) {
    suggEl.innerHTML = SUGGESTIONS_DATA.map(function (s, i) {
      return '<button class="sugg" type="button" data-sugg="' + i + '">' +
        srcIcon(s.type) + '<span>' + escapeHtml(s.text) + '</span></button>';
    }).join('');
  }
}

function escapeForAttr(s) {
  return String(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// E3: card de confirmação de ação
function renderActionCard(proposedAction, stack, q) {
  var resumo = (proposedAction && proposedAction.resumo) ? proposedAction.resumo : 'ação desconhecida';
  var html = '<div class="action-card">' +
    '<div class="action-header">' +
    '<span class="action-icon">⚡</span>' +
    '<span>Vou criar: <strong>' + escapeHtml(resumo) + '</strong></span>' +
    '</div>' +
    '<div class="action-btns">' +
    '<button class="btn btn-primary btn-sm action-confirm" type="button">Confirmar</button>' +
    '<button class="btn btn-ghost btn-sm action-cancel" type="button">Cancelar</button>' +
    '</div>' +
    '<div class="action-result"></div>' +
    '</div>';
  stack.innerHTML = html;

  var confirmBtn = stack.querySelector('.action-confirm');
  var cancelBtn = stack.querySelector('.action-cancel');
  var resultEl = stack.querySelector('.action-result');

  if (confirmBtn) confirmBtn.addEventListener('click', async function () {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    resultEl.innerHTML = '<span class="spin" aria-hidden="true"></span> Criando…';
    try {
      var res = await apiJSON('/portal/ask/execute', 'POST', { proposed_action: proposedAction });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) {
        var link = data.url ? ' <a href="' + escapeHtml(data.url) + '" target="_blank" rel="noopener">Abrir ↗</a>' : '';
        resultEl.innerHTML = '<span style="color:var(--green,#1a8a42)">✓ ' + escapeHtml(data.message || 'Criado!') + link + '</span>';
        // Add to history as completed action
        chatHistory.push({ role: 'user', content: q || resumo });
        chatHistory.push({ role: 'assistant', content: '✓ ' + (data.message || 'Criado!') + (data.url ? ' ' + data.url : '') });
        if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
      } else {
        resultEl.innerHTML = '<span style="color:var(--red,#c0392b)">✗ ' + escapeHtml(data.message || 'Erro ao criar.') + '</span>';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    } catch (e) {
      resultEl.innerHTML = '<span style="color:var(--red,#c0392b)">✗ Erro de conexão. Tente de novo.</span>';
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  if (cancelBtn) cancelBtn.addEventListener('click', function () {
    stack.innerHTML = '<div class="chat-block"><span class="muted">Ação cancelada.</span></div>';
    chatHistory.push({ role: 'user', content: q || resumo });
    chatHistory.push({ role: 'assistant', content: 'Ação cancelada.' });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
  });
}

function renderAskAnswer(answer, sources) {
  /* tool-chip */
  var nSrc = sources ? sources.length : 0;
  // E3 fix: remove duplicate "N fontes" — keep only the arg "(N fontes)" inside the chip.
  var toolChip = '<div class="tool-chip">' +
    '<span class="fn">brain_search</span>' +
    '<span class="arg">(' + escapeHtml(nSrc + (nSrc !== 1 ? ' fontes' : ' fonte')) + ')</span>' +
    '</div>';

  /* resposta: converter [n] em botoes de citacao */
  function replaceCitations(text) {
    return text.replace(/\[(\d+)\]/g, function (_, n) {
      return '<button class="cite-n" type="button" data-ref="' + n + '" aria-label="Fonte ' + n + '">' + n + '</button>';
    });
  }
  /* renderizar paragrafos escapando html mas preservando [n] depois de replace */
  var paragraphs = answer.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  var answerHtml = paragraphs.map(function (p) {
    return '<p>' + replaceCitations(escapeHtml(p)) + '</p>';
  }).join('');

  var answerBlock = '<div class="answer">' + answerHtml + '</div>';

  /* fontes citadas */
  var citesHtml = '';
  if (sources && sources.length) {
    citesHtml = '<div class="cites"><span class="cites-label">fontes citadas</span>' +
      sources.map(function (s, i) {
        var n = i + 1;
        var t = s.source_type || 'web';
        var title = s.title || '(sem titulo)';
        var safeUrl = isHttpUrl(s.source_url) ? s.source_url : null;
        var metaStr = [s.date || s.doc_date, s.db_name || s.db || TYPE_LABEL[t]].filter(Boolean).join(' · ');
        var chunkId = s.chunk_id || '';
        var feedbackBtns = chunkId
          ? '<span class="fb-btns">' +
              '<button class="fb-btn" type="button" data-fb-up data-chunk-id="' + escapeHtml(chunkId) + '" title="Util" aria-label="Util">&#128077;</button>' +
              '<button class="fb-btn" type="button" data-fb-down data-chunk-id="' + escapeHtml(chunkId) + '" title="Nao util" aria-label="Nao util">&#128078;</button>' +
            '</span>'
          : '';
        return '<details class="cite-card" data-cite="' + n + '" data-chunk-id="' + escapeHtml(chunkId) + '">' +
          '<summary><span class="cn">' + n + '</span>' + srcIcon(t) +
          (safeUrl
            ? '<a class="ttl" href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + escapeHtml(title) + '</a>'
            : '<span class="ttl">' + escapeHtml(title) + '</span>') +
          '<span class="meta">' + escapeHtml(metaStr) + '</span>' +
          feedbackBtns +
          '<svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</summary>' +
          (s.excerpt ? '<div class="cite-excerpt">' + escapeHtml(s.excerpt) +
            (safeUrl ? '<a class="src-link" href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener">abrir original &#8599;</a>' : '') +
            '</div>' : '') +
          '</details>';
      }).join('') + '</div>';
  }

  return toolChip + answerBlock + citesHtml;
}

function wireCiteRefs(scope) {
  scope.querySelectorAll('.cite-n').forEach(function (btn) {
    var n = btn.getAttribute('data-ref');
    var card = scope.querySelector('.cite-card[data-cite="' + n + '"]');
    if (!card) return;
    btn.addEventListener('mouseenter', function () { card.classList.add('hot'); });
    btn.addEventListener('mouseleave', function () { card.classList.remove('hot'); });
    btn.addEventListener('click', function () {
      card.open = true; card.classList.add('hot');
      var top = card.getBoundingClientRect().top;
      if (top < 60 || top > window.innerHeight - 120) {
        var main = document.scrollingElement;
        main.scrollTo({ top: main.scrollTop + top - window.innerHeight / 2, behavior: 'smooth' });
      }
      setTimeout(function () { card.classList.remove('hot'); }, 1200);
    });
  });
}

// Spec 004: feedback per cite source (1 voto por chunk por sessao de chat)
// votedChunks tracks which chunk IDs were voted in this session.
var votedChunks = {};

function wireFeedbackBtns(scope, currentQuery) {
  scope.querySelectorAll('.fb-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var chunkId = btn.getAttribute('data-chunk-id');
      if (!chunkId || votedChunks[chunkId]) return; // 1 vote per chunk per session
      var isUp = btn.hasAttribute('data-fb-up');
      votedChunks[chunkId] = true;
      // Mark voted visually
      var card = btn.closest('.cite-card');
      if (card) card.classList.add(isUp ? 'fb-up' : 'fb-down');
      btn.disabled = true;
      var sibling = btn.closest('.fb-btns')
        ? btn.closest('.fb-btns').querySelector(isUp ? '[data-fb-down]' : '[data-fb-up]')
        : null;
      if (sibling) sibling.disabled = true;
      // POST feedback (best-effort: failure swallowed silently)
      apiJSON('/portal/feedback', 'POST', {
        chunk_id: chunkId,
        value: isUp ? 'up' : 'down',
        query: currentQuery || ''
      }).catch(function () {});
    });
  });
}

function scrollBottom() {
  var se = document.scrollingElement;
  se.scrollTo({ top: se.scrollHeight, behavior: 'smooth' });
}

async function ask(q) {
  if (!q || chatBusy) return;
  chatBusy = true;

  var emptyEl = document.getElementById('chat-empty');
  var threadEl = document.getElementById('thread');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (threadEl) threadEl.classList.remove('hidden');

  /* bolha do usuario */
  var userEl = document.createElement('div');
  userEl.className = 'msg-user';
  userEl.innerHTML = '<div class="q"></div>';
  userEl.querySelector('.q').textContent = q;
  if (threadEl) threadEl.appendChild(userEl);

  /* shell da IA */
  var aiEl = document.createElement('div');
  aiEl.className = 'msg-ai';
  aiEl.innerHTML = '<span class="av">' + logoSvg(30) + '</span><div class="stack"></div>';
  if (threadEl) threadEl.appendChild(aiEl);
  var stack = aiEl.querySelector('.stack');

  /* chip carregando */
  stack.innerHTML = '<div class="tool-chip"><span class="spin" aria-hidden="true"></span>' +
    '<span><span class="fn">brain_search</span><span class="arg">buscando…</span></span></div>' +
    '<span class="typing" aria-label="Pensando"><i></i><i></i><i></i></span>';
  scrollBottom();

  try {
    // E3: envia histórico (últimas 6 mensagens)
    var historyToSend = chatHistory.slice(-6);
    var res = await apiJSON('/portal/ask', 'POST', { question: q, history: historyToSend });

    if (res.status === 402) {
      stack.innerHTML = '<div class="chat-block limit">' +
        '<span class="bh">Limite de consultas atingido</span>' +
        '<span>Faca o upgrade do plano para continuar.</span>' +
        '<button class="btn btn-primary btn-sm" type="button" onclick="location.href=\'/plano.html\'">Ver planos</button>' +
        '</div>';
      return;
    }

    if (!res.ok) {
      var b = await res.json().catch(function () { return {}; });
      var msg = b.error === 'invalid_question'
        ? 'A pergunta deve ter entre 3 e 500 caracteres.'
        : b.error === 'llm'
          ? 'Nao consegui gerar uma resposta agora. Tente de novo em instantes.'
          : 'Erro inesperado. Tente de novo.';
      stack.innerHTML = '<div class="chat-block neterr"><span class="bh">Erro</span><span>' + escapeHtml(msg) + '</span></div>';
      return;
    }

    var data = await res.json();
    var answer = data.answer || '';
    var sources = data.sources || [];
    var route = data.route || 'search';

    // E3: action route — show confirmation card
    if (route === 'action' && data.proposed_action) {
      renderActionCard(data.proposed_action, stack, q);
      scrollBottom();
      // Don't add to history until confirmed/cancelled (handled inside renderActionCard)
      return;
    }

    // meta or search route
    stack.innerHTML = renderAskAnswer(answer, route === 'meta' ? [] : sources);
    wireCiteRefs(stack);
    wireFeedbackBtns(stack, q); // Spec 004: wire 👍/👎 buttons
    scrollBottom();

    // E3: atualiza histórico
    chatHistory.push({ role: 'user', content: q });
    chatHistory.push({ role: 'assistant', content: answer });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
  } catch (e) {
    stack.innerHTML = '<div class="chat-block neterr">' +
      '<span class="bh">Sem conexao</span>' +
      '<span>Verifique a internet e tente de novo — nada e cobrado quando a consulta falha.</span>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-retry>Tentar de novo</button>' +
      '</div>';
    var retryBtn = stack.querySelector('[data-retry]');
    if (retryBtn) retryBtn.addEventListener('click', function () {
      if (threadEl) { threadEl.removeChild(aiEl); threadEl.removeChild(userEl); }
      chatBusy = false;
      ask(q);
    });
  } finally {
    chatBusy = false;
    scrollBottom();
  }
}

function wireChat() {
  var sendBtn = document.getElementById('send-btn');
  var inp = document.getElementById('composer-input');
  var suggEl = document.getElementById('suggestions');

  function send() {
    if (!inp) return;
    var q = inp.value.trim();
    if (!q || chatBusy) return;
    inp.value = '';
    inp.style.height = 'auto';
    ask(q);
  }

  if (sendBtn) sendBtn.addEventListener('click', send);
  if (inp) {
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    inp.addEventListener('input', function () {
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 130) + 'px';
    });
  }
  if (suggEl) {
    suggEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sugg]');
      if (b) ask(SUGGESTIONS_DATA[+b.getAttribute('data-sugg')].text);
    });
  }
}

/* ==================== WIRING de eventos globais ====================  */

function wireGlobal(me) {
  /* copy buttons */
  document.body.addEventListener('click', function (e) {
    /* guia chips */
    var chip = e.target.closest('.guia-chip');
    if (chip) {
      var chipTxt = chip.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(chipTxt) : Promise.reject())
        .then(function () {
          chip.classList.add('copied');
          setTimeout(function () { chip.classList.remove('copied'); }, 1800);
          toast('Copiado!');
        })
        .catch(function () { toast('Selecione e copie manualmente'); });
    }

    var c = e.target.closest('.copy-btn');
    if (c) {
      var txt = c.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
        .then(function () {
          c.textContent = 'copiado ✓'; c.classList.add('ok');
          setTimeout(function () { c.textContent = 'copiar'; c.classList.remove('ok'); }, 1800);
        })
        .catch(function () { toast('Selecione e copie manualmente'); });
    }
    var ct = e.target.closest('[data-copy-token]');
    if (ct) {
      var tok = ct.getAttribute('data-copy-token');
      (navigator.clipboard ? navigator.clipboard.writeText(tok) : Promise.reject())
        .then(function () { ct.textContent = 'Copiado ✓'; setTimeout(function () { ct.textContent = 'Copiar token'; }, 1800); })
        .catch(function () { toast('Selecione e copie manualmente'); });
    }
  });

  /* navegacao */
  document.body.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) go(nav.getAttribute('data-nav'));
  });

  /* activation steps */
  var stepsEl = document.getElementById('activation-steps');
  if (stepsEl) {
    stepsEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-step]');
      if (!b) return;
      var i = +b.getAttribute('data-step');
      /* Step 2 (Tarefas) com sub-fluxo inline: nao navega; os botoes internos tratam os cliques */
      if (i === 2 && !_actDone[2] && _actNotionConnected) return;
      if (ACT_STEPS[i].go) go(ACT_STEPS[i].go);
    });
  }

  /* logout */
  var logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', async function () {
    await api('/portal/logout', { method: 'POST' });
    location.href = '/';
  });

  /* fontes: delegacao de eventos */
  var fontesView = document.getElementById('view-fontes');
  if (fontesView) {
    fontesView.addEventListener('click', async function (e) {
      /* remover notion workspace */
      var rn = e.target.closest('[data-rm-notion]');
      if (rn) {
        var ws = rn.getAttribute('data-rm-notion');
        if (!confirm('Remover o Notion "' + ws + '"? Isto apaga as chaves e tudo que ja indexei desse workspace.')) return;
        rn.disabled = true;
        await apiJSON('/portal/notion/disconnect', 'POST', { workspace: ws });
        toast('Workspace removido');
        load(); return;
      }
      /* remover google */
      var rg = e.target.closest('[data-rm-google]');
      if (rg) {
        var em = rg.getAttribute('data-rm-google');
        await apiJSON('/portal/google/disconnect', 'POST', { email: em });
        toast(em + ' desconectado');
        load(); return;
      }
      /* remover ical */
      var ri = e.target.closest('[data-rm-ical]');
      if (ri) {
        var id = ri.getAttribute('data-rm-ical');
        await api('/portal/ical/' + id, { method: 'DELETE' });
        toast('Calendario removido');
        load(); return;
      }
    });

    /* notion connect: open in new tab so the success page shows without leaving portal */
    var notionAdd = document.getElementById('notion-add');
    if (notionAdd) notionAdd.addEventListener('click', function () {
      window.open(API + '/portal/notion/connect', '_blank', 'noopener');
    });

    /* PAT form */
    var patForm = document.getElementById('pat-form');
    if (patForm) patForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var pat = document.getElementById('pat-input').value.trim();
      if (!pat) return;
      var msgEl = document.getElementById('pat-msg');
      if (msgEl) { msgEl.classList.remove('hidden'); msgEl.textContent = 'Validando…'; }
      var res = await apiJSON('/portal/notion/pat', 'POST', { pat: pat });
      var body = await res.json().catch(function () { return {}; });
      if (res.ok) {
        document.getElementById('pat-input').value = '';
        if (msgEl) msgEl.textContent = 'Conectado via token: ' + (body.name || 'Notion') + '.';
        load();
      } else {
        if (msgEl) msgEl.textContent = body.error || 'Falha ao validar o token.';
      }
    });

    /* google add: open in new tab so the success page shows without leaving portal */
    var googleAdd = document.getElementById('google-add');
    if (googleAdd) googleAdd.addEventListener('click', function () {
      window.open(API + '/portal/google/connect', '_blank', 'noopener');
    });

    /* ical form */
    var icalForm = document.getElementById('ical-form');
    if (icalForm) icalForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var url = document.getElementById('ical-url').value.trim();
      var label = (document.getElementById('ical-label').value || '').trim();
      if (!url) return;
      await apiJSON('/portal/ical', 'POST', { url: url, label: label });
      icalForm.reset();
      toast('Calendario "' + (label || 'Calendario') + '" adicionado');
      load();
    });

    /* granola form */
    var grForm = document.getElementById('granola-form');
    if (grForm) grForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var key = document.getElementById('granola-key').value.trim();
      if (!key) return;
      await apiJSON('/portal/granola', 'PUT', { key: key });
      document.getElementById('granola-key').value = '';
      toast('Chave do Granola salva');
      load();
    });

    var grRm = document.getElementById('granola-remove');
    if (grRm) grRm.addEventListener('click', async function () {
      await api('/portal/granola', { method: 'DELETE' });
      toast('Chave do Granola removida');
      load();
    });

    /* reindex */
    var reindexBtn = document.getElementById('reindex-btn');
    if (reindexBtn) reindexBtn.addEventListener('click', runIndex);
  }

  /* assistant-list: revogar */
  var alEl = document.getElementById('assistant-list');
  if (alEl) {
    alEl.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-rm-assist]');
      if (!b) return;
      var tokenId = b.getAttribute('data-rm-assist');
      await revokeAssistant(tokenId);
    });
  }

  /* token gen */
  var tgenBtn = document.getElementById('token-gen-btn');
  if (tgenBtn) tgenBtn.addEventListener('click', generateToken);

  /* endpoint copy via data-copy no code-block */
  /* (ja tratado pelo handler de .copy-btn acima) */

  /* google unconfigured notice via query param */
  var params = new URLSearchParams(location.search);
  if (params.get('google') === 'unconfigured') {
    var gcEl = document.getElementById('google-unconfigured');
    if (gcEl) gcEl.classList.remove('hidden');
    if ((location.hash || '').replace(/^#/, '') !== 'fontes') {
      go('fontes');
    }
  }

  /* notion notice via query param */
  var notionP = params.get('notion');
  if (notionP) {
    var nNotice = document.getElementById('notion-notice');
    if (nNotice) {
      nNotice.classList.remove('hidden');
      if (notionP === 'connected') { nNotice.textContent = 'Notion conectado!'; nNotice.className = 'notice'; }
      else if (notionP === 'denied') { nNotice.textContent = 'Conexao do Notion cancelada.'; nNotice.className = 'notice err'; }
      else { nNotice.textContent = 'Nao consegui conectar o Notion. Tente de novo.'; nNotice.className = 'notice err'; }
    }
  }
}

/* ==================== TASKS (ativacao) ====================
   Endpoints preservados do fluxo de ativacao original:
   /portal/tasks/detect, /portal/tasks/create, /portal/tasks/use,
   /portal/activation/ask, /portal/activation/dismiss
   ===================================================================== */

function _tasksMsg(txt) {
  var el = document.getElementById('act-tasks-msg');
  if (el) el.textContent = txt;
}

function _tasksActions(html) {
  var el = document.getElementById('act-tasks-actions');
  if (el) el.innerHTML = html;
}

function _tasksActionsWire() {
  /* Botoes dinamicos gerados apos detectar: "Usar esta" e "Criar nova" */
  var el = document.getElementById('act-tasks-actions');
  if (!el) return;
  el.querySelectorAll('[data-use-tasks]').forEach(function (b) {
    b.addEventListener('click', function () { runUseTasks(b.getAttribute('data-use-tasks')); });
  });
  var cb = el.querySelector('[data-create-tasks]');
  if (cb) cb.addEventListener('click', function () { runCreateTasks(); });
}

async function runDetectTasks() {
  _tasksMsg('Procurando no seu Notion…');
  _tasksActions('');
  var res, det;
  try {
    res = await apiJSON('/portal/tasks/detect', 'POST');
    det = await res.json();
  } catch (e) {
    _tasksMsg('Erro de rede. Tente novamente.');
    return;
  }
  if (det.status === 'no-notion') {
    _tasksMsg('Conecte seu Notion em Fontes primeiro.');
    return;
  }
  if (det.status === 'none' || det.status === 'error' || !det.candidates || !det.candidates.length) {
    _tasksMsg('Nao encontrei base de tarefas. Quer que eu crie uma ("Zinom › Tarefas")?');
    _tasksActions('<button class="btn btn-ghost btn-sm" type="button" data-create-tasks>Criar base de Tarefas para mim</button>');
    _tasksActionsWire();
    return;
  }
  /* candidatos encontrados */
  _tasksMsg('Encontrei isto no seu Notion. Use uma, ou crie uma nova:');
  var btns = det.candidates.map(function (c) {
    return '<button class="btn btn-ghost btn-sm" type="button" data-use-tasks="' + escHtml(c.id) + '">Usar "' + escHtml(c.title) + '"</button>';
  }).join('');
  btns += '<button class="btn btn-ghost btn-sm" type="button" data-create-tasks>Criar nova</button>';
  _tasksActions(btns);
  _tasksActionsWire();
}

async function runCreateTasks() {
  _tasksMsg('Criando base de Tarefas…');
  _tasksActions('');
  var res;
  try {
    res = await apiJSON('/portal/tasks/create', 'POST');
  } catch (e) {
    _tasksMsg('Erro de rede. Tente novamente.');
    return;
  }
  if (res.ok) {
    load();
  } else {
    var b = await res.json().catch(function () { return {}; });
    _tasksMsg(b.error || 'Nao consegui criar. Tente configurar o token (PAT) em Fontes.');
  }
}

async function runUseTasks(dataSourceId) {
  _tasksMsg('Configurando…');
  _tasksActions('');
  try {
    await apiJSON('/portal/tasks/use', 'POST', { data_source_id: dataSourceId });
    load();
  } catch (e) {
    _tasksMsg('Erro ao salvar. Tente novamente.');
  }
}

async function markAskDone() {
  await apiJSON('/portal/activation/ask', 'POST');
  load();
}

async function dismissActivation() {
  await apiJSON('/portal/activation/dismiss', 'POST');
  load();
}

/* ==================== LOAD PRINCIPAL ====================  */

async function load() {
  var res;
  try { res = await api('/portal/me'); } catch (e) { location.href = '/'; return; }
  if (res.status === 401) { location.href = '/'; return; }
  var me = await res.json();
  window._lastMe = me;

  /* email na sidebar */
  var emailEl = document.getElementById('user-email');
  if (emailEl) emailEl.textContent = me.email || '—';

  /* logos */
  var brandLogo = document.getElementById('brand-logo');
  if (brandLogo) brandLogo.innerHTML = logoSvg(26);
  var brandLogoM = document.getElementById('brand-logo-m');
  if (brandLogoM) brandLogoM.innerHTML = logoSvg(24);
  var actLogo = document.getElementById('activation-logo');
  if (actLogo) actLogo.innerHTML = logoSvg(18);

  /* icons por data-icon */
  document.querySelectorAll('[data-icon]').forEach(function (el) {
    var t = el.getAttribute('data-icon');
    el.innerHTML = ICONS[t] || '';
    el.style.color = ICON_COLOR[t] || '';
  });

  /* google accounts (lista separada de /portal/google/accounts) */
  var googleAccounts = [];
  try {
    var gRes = await api('/portal/google/accounts');
    if (gRes.ok) googleAccounts = await gRes.json();
  } catch (e) { /* ignore */ }
  me.sources = me.sources || {};
  me.sources.google = googleAccounts.map(function (a) { return a.email; });
  me.google_configured = me.google_configured !== false;

  renderFontes(me);
  await loadActivation(me.sources);
  await loadMcpTokens();
  renderInicio(me, window._lastBilling);
  renderChatEmpty(me);
}

/* ==================== INIT ====================  */

var booted = false;
function init() {
  if (booted) return;
  booted = true;

  wireGlobal(null);
  wireAtividade();
  wireConnectWindow();
  wireChat();

  /* rota inicial */
  var hash = (location.hash || '#inicio').slice(1).split('?')[0];
  var validViews = ['inicio', 'chat', 'fontes', 'atividade', 'guia'];
  go(validViews.includes(hash) ? hash : 'inicio');

  load();
  loadBilling();
  loadStatus();
  loadBrain(true);
}

window.addEventListener('hashchange', function () {
  var h = (location.hash || '#inicio').slice(1).split('?')[0];
  var validViews = ['inicio', 'chat', 'fontes', 'atividade', 'guia'];
  if (validViews.includes(h)) go(h);
});

/* 1.1: Refetch when the user returns from the OAuth tab (visibilitychange). */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') {
    load();
  }
});

document.addEventListener('DOMContentLoaded', init);
if (document.readyState !== 'loading') init();

/* ---- Exclusão de conta (Zona de perigo) ---- */
(function () {
  var deleteBtn = document.getElementById('delete-account-btn');
  var dialog = document.getElementById('delete-account-dialog');
  var cancelBtn = document.getElementById('delete-cancel-btn');
  var confirmInput = document.getElementById('delete-confirm-input');
  var confirmBtn = document.getElementById('delete-confirm-btn');
  var errorMsg = document.getElementById('delete-error-msg');

  if (!deleteBtn || !dialog) return;

  deleteBtn.addEventListener('click', function () {
    confirmInput.value = '';
    confirmBtn.disabled = true;
    errorMsg.textContent = '';
    dialog.showModal();
    confirmInput.focus();
  });

  cancelBtn.addEventListener('click', function () {
    dialog.close();
  });

  confirmInput.addEventListener('input', function () {
    confirmBtn.disabled = confirmInput.value !== 'EXCLUIR';
  });

  confirmBtn.addEventListener('click', async function () {
    if (confirmInput.value !== 'EXCLUIR') return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Excluindo…';
    errorMsg.textContent = '';
    try {
      var r = await apiJSON('/portal/delete-account', 'POST', { confirm: 'EXCLUIR' });
      if (r.ok) {
        dialog.close();
        window.location.href = '/?deleted=1';
      } else {
        var body = await r.json().catch(function () { return {}; });
        errorMsg.textContent = body.error || 'Erro ao excluir conta. Tente novamente.';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Excluir permanentemente';
      }
    } catch (e) {
      errorMsg.textContent = 'Erro de rede. Tente novamente.';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Excluir permanentemente';
    }
  });

  // Close dialog on backdrop click
  dialog.addEventListener('click', function (e) {
    if (e.target === dialog) dialog.close();
  });
})();
