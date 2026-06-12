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

/* ---- tempo relativo (pt-BR) ---- */
function relTime(ts) {
  if (!ts) return '';
  var t = new Date(ts).getTime();
  if (!isFinite(t)) return '';
  var diff = Date.now() - t;
  if (diff < 0) diff = 0;
  var min = Math.round(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return 'há ' + min + ' min';
  var h = Math.round(min / 60);
  if (h < 24) return 'há ' + h + 'h';
  var d = Math.round(h / 24);
  if (d === 1) return 'ontem';
  if (d < 30) return 'há ' + d + ' dias';
  var mo = Math.round(d / 30);
  return 'há ' + mo + (mo > 1 ? ' meses' : ' mês');
}

/* idade em horas de um timestamp (Infinity quando ausente/inválido) */
function ageHours(ts) {
  if (!ts) return Infinity;
  var t = new Date(ts).getTime();
  if (!isFinite(t)) return Infinity;
  return (Date.now() - t) / 3600000;
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

/* ---- prompts de tarefas e planejamento (003-tasks-v1) ----
   FONTE ÚNICA dos textos: Guia (seção Tarefas) e Receitas leem daqui.
   Os textos dos prompts de reunião/dia/semana/mês/cobranças são os do spec. */
var TASK_PROMPTS = {
  reuniao: 'Pega minha última reunião do Granola, identifica o que EU tenho que fazer e o que eu tenho que COBRAR de alguém, confere o que já existe no board e cria as tarefas que faltam com origem e prazo.',
  reuniao_especifica: 'Pega a reunião "[nome ou tema da reunião]" no Granola, identifica o que EU tenho que fazer e o que eu tenho que COBRAR de alguém, confere o que já existe no board e cria as tarefas que faltam com origem e prazo.',
  dia: 'Planeja meu dia de amanhã: cruza minha agenda com as tarefas abertas, sugere o que fazer em cada espaço livre e cria os blocktimes que eu aprovar.',
  semana: 'Planeja minha semana: distribui as tarefas abertas pelos dias conforme prazo, prioridade e tempo estimado, respeitando minha agenda.',
  mes: 'Faz o plano do mês: grandes entregas por semana, o que está atrasado e o que dá pra cortar.',
  cobrancas: 'Lista minhas tarefas de cobrar, agrupadas por pessoa, com há quanto tempo estão paradas.',
  revisao_semana: 'Faz minha revisão da semana no board: o que concluí, o que está atrasado, cobranças paradas e o que reprogramar para a semana que vem.',
  fechar_dia: 'Fecha meu dia: confere o que fiz hoje, marca as tarefas concluídas no board e reprograma o que ficou pendente.'
};

/* preenche os code-blocks do Guia e das Receitas a partir de TASK_PROMPTS */
function applyTaskPrompts() {
  var map = {
    'guia-prompt-reuniao': TASK_PROMPTS.reuniao,
    'guia-prompt-reuniao-especifica': TASK_PROMPTS.reuniao_especifica,
    'guia-prompt-dia': TASK_PROMPTS.dia,
    'guia-prompt-semana': TASK_PROMPTS.semana,
    'guia-prompt-mes': TASK_PROMPTS.mes,
    'guia-prompt-revisao': TASK_PROMPTS.revisao_semana,
    'guia-prompt-cobrancas': TASK_PROMPTS.cobrancas,
    'recipe-task-reuniao': TASK_PROMPTS.reuniao,
    'recipe-task-cobrancas': TASK_PROMPTS.cobrancas,
    'recipe-task-semana': TASK_PROMPTS.semana,
    'recipe-task-fechar-dia': TASK_PROMPTS.fechar_dia,
    'recipe-plan-dia': TASK_PROMPTS.dia,
    'recipe-plan-revisao': TASK_PROMPTS.revisao_semana
  };
  Object.keys(map).forEach(function (id) {
    fillPromptBlock(document.getElementById(id), map[id]);
  });
}

/* ---- navegação por hash ---- */
var VIEWS = ['inicio', 'fontes', 'atividade', 'consultar', 'guia', 'conta'];

function go(view) {
  // plano vai para /plano.html (link externo)
  if (view === 'plano') { location.href = '/plano.html'; return; }
  if (view === 'chat') view = 'consultar'; // rota legada
  if (!VIEWS.includes(view)) view = 'inicio';
  document.querySelectorAll('.view').forEach(function (v) {
    v.classList.toggle('active', v.id === 'view-' + view);
  });
  document.querySelectorAll('[data-nav]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-nav') === view);
  });
  var mn = document.getElementById('mobile-view-name');
  if (mn) mn.textContent = view;
  /* Conta: a lista de sessões era carregada só no boot e ficava stale —
     recarrega ao entrar na view */
  if (view === 'conta' && typeof loadSessions === 'function') loadSessions();
  document.scrollingElement.scrollTo({ top: 0 });
  try { history.replaceState(null, '', '#' + view); } catch (e) { /* sandbox */ }
}

/* deep-link/ação: ir ao Guia e rolar até uma seção (guia-conectar, guia-tarefas) */
function goGuiaSection(anchorId) {
  go('guia');
  var anchor = document.getElementById(anchorId);
  if (anchor) setTimeout(function () {
    var top = anchor.getBoundingClientRect().top + document.scrollingElement.scrollTop - 20;
    document.scrollingElement.scrollTo({ top: top, behavior: 'smooth' });
  }, 60);
}

function goGuiaConectar() { goGuiaSection('guia-conectar'); }

/* ==================== INÍCIO (v2: painel vivo + onboarding) ====================
   Estado derivado de /portal/me + /portal/status:
   ativado = tem fonte conectada E índice com chunks > 0; novo = caso contrário.
   ================================================ */

/* estado local de assistentes (tokens MCP crus de /portal/mcp-tokens) */
var assistants = [];

function hasAnySource(me) {
  var s = (me && me.sources) || {};
  return !!(
    (s.notion && s.notion.connected) ||
    (s.google && s.google.length) ||
    (s.ical && s.ical.links && s.ical.links.length) ||
    (s.granola && s.granola.set)
  );
}

function countSources(me) {
  var s = (me && me.sources) || {};
  var n = 0;
  if (s.notion && s.notion.connected) n++;
  if (s.google && s.google.length) n++;
  if (s.ical && s.ical.links && s.ical.links.length) n++;
  if (s.granola && s.granola.set) n++;
  return n;
}

/* contagem por tipo: "2 Notion · 4 agendas · Granola" + total de conexões */
function sourcesBreakdown(me) {
  var s = (me && me.sources) || {};
  var nNotion = (s.notion && s.notion.workspaces && s.notion.workspaces.length) ||
    (s.notion && s.notion.connected ? 1 : 0);
  var nCal = ((s.google && s.google.length) || 0) +
    ((s.ical && s.ical.links && s.ical.links.length) || 0);
  var hasGranola = !!(s.granola && s.granola.set);
  var parts = [];
  if (nNotion) parts.push(nNotion + ' Notion');
  if (nCal) parts.push(nCal + (nCal > 1 ? ' agendas' : ' agenda'));
  if (hasGranola) parts.push('Granola');
  return {
    total: nNotion + nCal + (hasGranola ? 1 : 0),
    label: parts.join(' · ')
  };
}

function totalChunks(st) {
  return (st && st.counts && st.counts.totals && st.counts.totals.chunks) || 0;
}

function lastIndexedAt(st) {
  return ((st && st.counts && st.counts.bySource) || []).reduce(function (m, s) {
    return s.last_indexed_at && s.last_indexed_at > m ? s.last_indexed_at : m;
  }, '');
}

/* ---- alternância ativado/novo ---- */
function updateZState() {
  var me = window._lastMe;
  var st = window._lastStatus;
  if (!me) return;
  /* sem status só renderiza em modo degradado (falha de /portal/status);
     fora isso espera os dois antes de mostrar qualquer estado */
  if (!st && !window._statusUnavailable) return;
  var ativado = st ? (hasAnySource(me) && totalChunks(st) > 0) : hasAnySource(me);
  document.body.setAttribute('data-zstate', ativado ? 'ativado' : 'novo');
  if (ativado) {
    renderHello();
    renderHealth();
  } else {
    renderOnboarding();
  }
}

/* ---- saudação (estado ativado) ---- */
function renderHello() {
  var me = window._lastMe;
  var st = window._lastStatus;
  var titleEl = document.getElementById('hello-title');
  var statusEl = document.getElementById('hello-status-text');
  if (titleEl) {
    var name = '';
    if (me && me.email) {
      var local = String(me.email).split('@')[0].split(/[._-]/)[0];
      if (local) name = local.charAt(0).toUpperCase() + local.slice(1);
    }
    titleEl.textContent = name ? 'Seu cérebro está em dia, ' + name : 'Seu cérebro está em dia';
  }
  if (statusEl && st) {
    var n = countSources(me);
    var last = lastIndexedAt(st);
    statusEl.textContent = n + (n === 1 ? ' fonte' : ' fontes') + ' · ' +
      fmt(totalChunks(st)) + ' trechos · ' +
      (last ? 'sincronizado ' + relTime(last) : 'aguardando primeira indexação');
  }
}

/* ---- Saúde do cérebro (client-side, determinístico — regras do spec) ----
   Base 100. Fonte em erro: −25. Fonte com last_run > 7 dias: −20; > 48h: −10.
   Nenhum token MCP jamais usado: −15. Índice vazio: score 0 ("Configure").
   Faixas: ≥90 Excelente · ≥70 Bom · ≥40 Atenção · <40 Crítico. */
function computeHealth(st, tokens) {
  var items = [];
  var score = 100;

  if (!st || totalChunks(st) === 0) {
    return {
      score: 0,
      word: 'Configure',
      sub: 'Seu cérebro ainda não tem conteúdo indexado.',
      items: [{
        level: 'warn',
        html: '<strong>Índice vazio.</strong> Conecte uma fonte e rode a primeira indexação.',
        act: { nav: 'fontes', label: 'indexar →' }
      }]
    };
  }

  var okNames = [];
  (st.sources || []).forEach(function (s) {
    var name = s.display_name || s.source || s.source_type || 'Fonte';
    var estado = s.estado || (s.ok === false ? 'erro' : (s.last_run ? 'ok' : 'aguardando_primeira_indexacao'));
    if (estado === 'erro') {
      score -= 25;
      items.push({
        level: 'warn',
        html: '<strong>' + escapeHtml(name) + ' com erro de sincronização.</strong> As atualizações dessa fonte não estão entrando no cérebro.',
        act: { nav: 'fontes', label: 'corrigir →' }
      });
      return;
    }
    /* conectada mas nunca rodou (e não está indexando agora): pendência, não "ok" */
    if (!s.last_run && estado !== 'indexando') {
      score -= 10;
      items.push({
        level: 'warn',
        html: '<strong>' + escapeHtml(name) + ' nunca sincronizou</strong> — rode Indexar agora.',
        act: { nav: 'fontes', label: 'indexar →' }
      });
      return;
    }
    var h = ageHours(s.last_run);
    if (h > 24 * 7 && isFinite(h)) {
      score -= 20;
      items.push({
        level: 'warn',
        html: '<strong>' + escapeHtml(name) + ' sem sincronizar há ' + Math.floor(h / 24) + ' dias.</strong> O conteúdo recente dessa fonte não está no cérebro.',
        act: { nav: 'fontes', label: 'corrigir →' }
      });
    } else if (h > 48 && isFinite(h)) {
      score -= 10;
      items.push({
        level: 'warn',
        html: '<strong>' + escapeHtml(name) + ' sem sincronizar há ' + Math.floor(h / 24) + ' dias.</strong> Rode "Indexar agora" para atualizar.',
        act: { nav: 'fontes', label: 'indexar →' }
      });
    } else {
      okNames.push(name);
    }
  });

  var anyUsed = (tokens || []).some(function (t) { return !!t.last_used_at; });
  if (!anyUsed) {
    score -= 15;
    items.push({
      level: 'warn',
      html: '<strong>Nenhuma IA usou seu cérebro ainda.</strong> Conecte um assistente para começar a aproveitar o índice.',
      act: { guia: 'conectar', label: 'como fazer →' }
    });
  }

  if (score < 0) score = 0;
  var warns = items.filter(function (i) { return i.level === 'warn'; }).length;
  if (okNames.length) {
    items.push({ level: 'ok', html: escapeHtml(okNames.join(', ')) + ' sincronizando normalmente.' });
  } else if (!items.length) {
    items.push({ level: 'ok', html: 'Tudo sincronizando normalmente.' });
  }

  var faixa = score >= 90 ? 'Excelente' : score >= 70 ? 'Bom' : score >= 40 ? 'Atenção' : 'Crítico';
  var word = warns ? faixa + ' — ' + warns + (warns > 1 ? ' pendências' : ' pendência') : faixa;
  var sub = warns
    ? (warns > 1 ? 'Resolver as pendências leva o recall ao máximo.' : 'Resolver a pendência leva o recall ao máximo.')
    : 'Tudo em ordem — sua IA enxerga o cérebro completo.';
  return { score: score, word: word, sub: sub, items: items };
}

function renderHealth() {
  var st = window._lastStatus;
  if (!st) return;
  var h = computeHealth(st, assistants);
  var ring = document.getElementById('health-ring-fg');
  var scoreEl = document.getElementById('health-score');
  var wordEl = document.getElementById('health-word');
  var subEl = document.getElementById('health-sub');
  var listEl = document.getElementById('health-list');
  var CIRC = 169.6;
  if (ring) {
    ring.setAttribute('stroke-dashoffset', String(CIRC * (1 - h.score / 100)));
    ring.setAttribute('stroke', h.score >= 70 ? 'var(--accent)' : 'var(--warn)');
  }
  if (scoreEl) scoreEl.textContent = String(h.score);
  if (wordEl) wordEl.textContent = h.word;
  if (subEl) subEl.textContent = h.sub;
  if (listEl) {
    listEl.innerHTML = h.items.map(function (it) {
      var act = '';
      if (it.act) {
        act = it.act.guia
          ? '<a class="act" href="#guia" data-nav="guia" data-guia="' + it.act.guia + '">' + it.act.label + '</a>'
          : '<a class="act" href="#' + it.act.nav + '" data-nav="' + it.act.nav + '">' + it.act.label + '</a>';
      }
      return '<div class="health-item ' + it.level + '">' +
        '<span class="hi">' + (it.level === 'warn' ? '!' : '✓') + '</span>' +
        '<span class="grow">' + it.html + '</span>' + act + '</div>';
    }).join('');
  }
}

/* ---- onboarding (estado novo) ---- */
function renderOnboarding() {
  var me = window._lastMe;
  var st = window._lastStatus;
  var wrap = document.getElementById('onb-steps');
  if (!wrap) return;
  var srcDone = hasAnySource(me);
  var idxDone = totalChunks(st) > 0;
  var aiDone = assistants.length > 0;
  /* passo Tarefas: done quando activation.items.tasks (003-tasks-v1) */
  var tasksDone = _actTasksDone;
  var steps = [
    {
      done: true,
      st: 'Criar sua conta',
      sd: 'Feito — você entrou com ' + escapeHtml((me && me.email) || 'seu e-mail') + '.'
    },
    {
      done: srcDone,
      st: 'Conectar a primeira fonte',
      sd: 'Comece pelo Notion — é de onde vem a maior parte do conhecimento. Granola e agendas podem vir depois.',
      cta: '<button class="btn btn-primary btn-sm" type="button" data-nav="fontes">Conectar Notion →</button>'
    },
    {
      done: tasksDone,
      st: 'Onde suas tarefas vivem',
      sd: 'Aponte a base de tarefas que você já tem no Notion — o Zinom se adapta aos seus campos — ou crie o Kanban padrão Zinom (a página "🧠 Zinom" com a base "Tarefas" no topo do seu workspace): status, prioridade, prazo, tempo estimado, tipo (fazer ou cobrar), quem e origem. Dá para trocar a base depois em Fontes.',
      cta: '<div class="task-choice js-tasks-actions">' +
        '<button class="btn btn-primary btn-sm" type="button" data-tasks-detect>Já tenho uma base no Notion</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-tasks-create>Criar o Kanban padrão Zinom</button>' +
        '</div><p class="muted js-tasks-msg" style="font-size:12.5px;margin:7px 0 0"></p>'
    },
    {
      done: idxDone,
      st: 'Indexar o cérebro',
      sd: 'Um clique. A primeira indexação leva alguns minutos — você pode acompanhar em Atividade.',
      cta: '<button class="btn btn-primary btn-sm" type="button" data-nav="fontes">Indexar agora →</button>'
    },
    {
      done: aiDone,
      st: 'Plugar sua IA e perguntar',
      sd: 'Claude.ai, Claude Code, ChatGPT ou qualquer cliente MCP. O Guia tem o passo a passo de cada um.',
      cta: '<button class="btn btn-primary btn-sm" type="button" data-nav="guia" data-guia="conectar">Ver o passo a passo →</button>'
    }
  ];
  var nowSet = false;
  wrap.innerHTML = steps.map(function (s, i) {
    var cls = 'onb-step' + (s.done ? ' done' : '');
    var isNow = !s.done && !nowSet;
    if (isNow) { cls += ' now'; nowSet = true; }
    var num = s.done ? '✓' : String(i + 1);
    var cta = (isNow && s.cta) ? '<div class="cta">' + s.cta + '</div>' : '';
    return '<div class="' + cls + '">' +
      '<span class="num">' + num + '</span>' +
      '<div class="grow"><div class="st">' + s.st + '</div><div class="sd">' + s.sd + '</div>' + cta + '</div>' +
      '</div>';
  }).join('');
}

/* ---- assistentes conectados (estado ativado) ---- */
function renderAssistRows() {
  var tagEl = document.getElementById('assistants-tag');
  if (tagEl) tagEl.textContent = assistants.length;
  var wrap = document.getElementById('assist-rows');
  if (!wrap) return;
  if (!assistants.length) {
    wrap.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0">Nenhum assistente conectado ainda — leva menos de 5 minutos no Guia.</p>';
    return;
  }
  wrap.innerHTML = assistants.map(function (t) {
    var used = t.last_used_at;
    var idle = !used || ageHours(used) > 24 * 7;
    var meta = used ? 'usado ' + relTime(used)
      : (t.created_at ? 'criado ' + relTime(t.created_at) + ' · nunca usado' : 'nunca usado');
    return '<div class="assist-row"><span class="dot' + (idle ? ' idle' : '') + '"></span>' +
      '<span class="nm">' + escapeHtml(t.label || 'Claude Code') + '</span>' +
      '<span class="meta">' + escapeHtml(meta) + '</span>' +
      '<button class="link-quiet" type="button" data-rm-assist="' + escapeHtml(String(t.id)) + '">revogar</button></div>';
  }).join('');
}

/* renderInicio: mantém a assinatura usada pelo restante do código */
function renderInicio(me, billing) {
  renderConnectActiveBadge();
  renderAssistRows();
  renderContaTokens();
  updateZState();
}

/* ---- Sua semana (GET /portal/week — degrada escondendo o card) ---- */
async function loadWeek() {
  var card = document.getElementById('card-week');
  if (!card) return;
  try {
    var res = await api('/portal/week');
    if (!res.ok) { card.classList.add('hidden'); return; }
    var w = await res.json();
    card.classList.remove('hidden');
    var numsEl = document.getElementById('week-nums');
    if (numsEl) {
      numsEl.innerHTML =
        '<div class="wn"><strong>' + fmt(w.documents || 0) + '</strong><span>documentos novos</span></div>' +
        '<div class="wn"><strong>' + fmt(w.meetings || 0) + '</strong><span>' + ((w.meetings || 0) === 1 ? 'reunião' : 'reuniões') + '</span></div>' +
        '<div class="wn"><strong>' + fmt((w.by_source || []).length) + '</strong><span>fontes com novidade</span></div>';
    }
    var listEl = document.getElementById('week-list');
    if (listEl) {
      var recent = (w.recent || []).slice(0, 6);
      listEl.innerHTML = recent.length
        ? recent.map(function (r) {
            return '<div class="week-item">' + srcIcon(r.source_type || 'web') +
              '<span class="t">' + escapeHtml(r.title || '(sem título)') + '</span>' +
              '<span class="m">' + escapeHtml(relTime(r.indexed_at)) + '</span></div>';
          }).join('')
        : '<p class="muted" style="font-size:13px;padding:6px 0">Nada novo nos últimos 7 dias.</p>';
    }
  } catch (e) { card.classList.add('hidden'); }
}

/* ---- O que sua IA buscou (GET /portal/ai-searches — degrada p/ estado vazio) ---- */
async function loadAiSearches() {
  var listEl = document.getElementById('feed-list');
  if (!listEl) return;
  var searches = null;
  try {
    var res = await api('/portal/ai-searches');
    if (res.ok) {
      var data = await res.json();
      searches = data.searches || [];
    }
  } catch (e) { /* degrada */ }
  if (!searches || !searches.length) {
    listEl.innerHTML = '<div class="feed-empty">Nenhuma busca ainda. Conecte sua IA e pergunte algo — cada busca aparece aqui. ' +
      '<a href="#guia" data-nav="guia" data-guia="conectar">Conectar uma IA →</a></div>';
    return;
  }
  listEl.innerHTML = searches.slice(0, 8).map(function (s) {
    var meta = [(s.results != null ? s.results + (s.results === 1 ? ' trecho' : ' trechos') : null), relTime(s.ts)]
      .filter(Boolean).join(' · ');
    return '<div class="feed-row"><span class="who">' + escapeHtml(s.client || 'IA') + '</span>' +
      '<span class="q">"' + escapeHtml(s.query || '') + '"</span>' +
      '<span class="meta">' + escapeHtml(meta) + '</span></div>';
  }).join('');
}

/* ---- Próxima reunião (GET /portal/next-meeting) ---- */
window._nextMeeting = null;

/* YYYY-MM-DD (date-only) → Date local, sem deslocamento de fuso; null se não for date-only */
function parseDateOnly(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function meetingWhenParts(startsAt, allDay) {
  var dateOnly = parseDateOnly(startsAt);
  var isAllDay = !!allDay || !!dateOnly;
  var d = dateOnly || new Date(startsAt);
  if (!isFinite(d.getTime())) return { day: '', time: '' };
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var diffDays = Math.round((that - today) / 86400000);
  var day;
  if (diffDays === 0) day = 'hoje';
  else if (diffDays === 1) day = 'amanhã';
  else if (diffDays < 7) day = d.toLocaleDateString('pt-BR', { weekday: 'long' });
  else day = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  /* all-day: só o dia, sem horário fantasma */
  var time = isAllDay ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return { day: day, time: time };
}

function briefingPrompt(m) {
  var w = meetingWhenParts(m.starts_at, m.all_day);
  return 'Prepara meu briefing para a reunião "' + m.title + '" de ' + w.day + (w.time ? ' às ' + w.time : '') +
    ': contexto, decisões anteriores e pendências.';
}

/* atualiza um .code-block mantendo o botão copiar */
function fillPromptBlock(el, text) {
  if (!el) return;
  var btn = el.querySelector('.copy-btn');
  el.textContent = text;
  if (btn) {
    btn.setAttribute('data-copy', text);
    btn.textContent = 'copiar';
    el.appendChild(btn);
  }
}

async function loadNextMeeting() {
  var body = document.getElementById('next-meeting-body');
  if (!body) return;
  var emptyHtml = '<p class="muted" style="font-size:13px;padding:6px 0">Nenhuma reunião futura nas suas agendas indexadas.</p>' +
    '<p class="muted" style="font-size:12px">Conecte uma agenda em <a href="#fontes" data-nav="fontes">Fontes</a> para ver o briefing aqui.</p>';
  try {
    var res = await api('/portal/next-meeting');
    if (!res.ok) { body.innerHTML = emptyHtml; return; }
    var m = await res.json();
    if (!m || !m.found) { body.innerHTML = emptyHtml; window._nextMeeting = null; return; }
    window._nextMeeting = m;
    var w = meetingWhenParts(m.starts_at, m.all_day);
    var sub = [m.calendar, (m.attendees && m.attendees.length ? 'com ' + m.attendees.slice(0, 3).join(' e ') : null)]
      .filter(Boolean).join(' · ');
    var prompt = briefingPrompt(m);
    body.innerHTML =
      '<div class="next-meeting">' +
      '<span class="nm-when">' + escapeHtml(w.day) + (w.time ? '<br>' + escapeHtml(w.time) : '') + '</span>' +
      '<div class="grow"><div class="nm-title">' + escapeHtml(m.title || '(sem título)') + '</div>' +
      (sub ? '<div class="nm-sub">' + escapeHtml(sub) + '</div>' : '') + '</div></div>' +
      '<div class="code-block mt-sm" style="white-space:pre-wrap" id="meeting-prompt">' + escapeHtml(prompt) +
      '<button class="copy-btn" type="button" data-copy="' + escapeHtml(prompt) + '">copiar</button></div>' +
      '<div class="card-foot">Cole no Claude.ai ou em qualquer IA conectada.</div>';
    /* parametriza a receita "Briefing da próxima reunião" no Guia */
    fillPromptBlock(document.getElementById('recipe-briefing'), prompt);
  } catch (e) { body.innerHTML = emptyHtml; }
}

/* ---- carregar tokens MCP (lista crua: label, last_used_at, created_at) ---- */
async function loadMcpTokens() {
  try {
    var res = await api('/portal/mcp-tokens');
    if (!res.ok) return;
    var list = await res.json();
    assistants = list || [];
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

/* ==================== CONTA ====================  */

function renderConta(me) {
  var emailEl = document.getElementById('conta-email');
  if (emailEl) emailEl.textContent = (me && me.email) || '—';
  var sinceEl = document.getElementById('conta-member-since');
  if (sinceEl) {
    if (me && me.created_at) {
      var d = new Date(me.created_at);
      sinceEl.textContent = isFinite(d.getTime())
        ? d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
        : '—';
    } else {
      sinceEl.textContent = '—';
    }
  }
}

/* tokens MCP na Conta (mesma fonte de dados dos assistentes) */
function renderContaTokens() {
  var tag = document.getElementById('conta-tokens-tag');
  if (tag) tag.textContent = assistants.length;
  var wrap = document.getElementById('conta-token-list');
  if (!wrap) return;
  if (!assistants.length) {
    wrap.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0">Nenhum token ativo. Gere um no Guia para conectar uma IA.</p>';
    return;
  }
  wrap.innerHTML = assistants.map(function (t) {
    var meta = t.last_used_at ? 'usado ' + relTime(t.last_used_at)
      : (t.created_at ? 'criado ' + relTime(t.created_at) : 'nunca usado');
    return '<div class="kv-row"><span class="k">' + escapeHtml(t.label || 'Claude Code') + '</span>' +
      '<span class="v masked">token ••••' + escapeHtml(String(t.id || '').slice(-4)) + '</span>' +
      '<span class="muted" style="font-size:11.5px;font-family:var(--mono);white-space:nowrap">' + escapeHtml(meta) + '</span>' +
      '<button class="link-quiet" type="button" data-rm-assist="' + escapeHtml(String(t.id)) + '">revogar</button></div>';
  }).join('');
}

/* sessões ativas (GET /portal/sessions — degrada graciosamente) */
function uaShort(ua) {
  if (!ua) return 'Sessão';
  var browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  var os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : '';
  return browser + (os ? ' · ' + os : '');
}

async function loadSessions() {
  var wrap = document.getElementById('sessions-list');
  var tag = document.getElementById('sessions-tag');
  if (!wrap) return;
  try {
    var res = await api('/portal/sessions');
    if (!res.ok) throw new Error('falha');
    var data = await res.json();
    var sessions = data.sessions || [];
    if (tag) tag.textContent = sessions.length;
    if (!sessions.length) {
      wrap.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0">Nenhuma sessão ativa.</p>';
      return;
    }
    wrap.innerHTML = sessions.map(function (s) {
      var k = s.current ? 'Este navegador' : uaShort(s.user_agent);
      var meta = [s.current ? uaShort(s.user_agent) : null, relTime(s.last_seen_at || s.created_at)].filter(Boolean).join(' · ');
      var right = s.current
        ? '<span class="tag ok">atual</span>'
        : '<button class="link-quiet" type="button" data-rm-session="' + escapeHtml(String(s.id)) + '">encerrar</button>';
      return '<div class="kv-row"><span class="k">' + escapeHtml(k) + '</span>' +
        '<span class="v muted" style="font-size:12.5px">' + escapeHtml(meta) + '</span>' + right + '</div>';
    }).join('');
  } catch (e) {
    if (tag) tag.textContent = '—';
    wrap.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0">Não consegui carregar as sessões agora.</p>';
  }
}

async function revokeSession(id, isCurrent) {
  try {
    var res = await apiJSON('/portal/sessions/revoke', 'POST', { id: id });
    /* 404 = a sessão já tinha expirado/sido encerrada (lista stale) — trate como
       encerrada e recarregue a lista em vez de deixar a linha fantasma na tela */
    if (res.status === 404) { toast('Essa sessão já estava encerrada.'); loadSessions(); return; }
    if (!res.ok && res.status !== 204) { toast('Não consegui encerrar a sessão.'); loadSessions(); return; }
    if (isCurrent) { location.href = '/login.html'; return; }
    toast('Sessão encerrada');
    loadSessions();
  } catch (e) { toast('Erro de rede ao encerrar sessão.'); }
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
    var lastAt = lastIndexedAt(st);
    sync.textContent = busy ? 'indexando agora…'
      : (lastAt ? 'sincronizado ' + relTime(lastAt) : 'aguardando primeira indexação');
  } else {
    chunks.textContent = '—';
    sync.textContent = busy ? 'indexando agora…' : 'sincronizado';
  }
}

/* ==================== FONTES ====================  */

/* status (de /portal/status) de uma fonte pelo source_type lógico */
function sourceStatusFor(type) {
  var st = window._lastStatus;
  if (!st || !st.sources) return null;
  return st.sources.find(function (s) {
    var t = s.source_type || (s.source && s.source.indexOf('notion') === 0 ? 'notion'
      : s.source && s.source.indexOf('granola') === 0 ? 'granola'
      : s.source && (s.source.indexOf('calendar') === 0 || s.source.indexOf('gcal') === 0) ? 'calendar' : 'web');
    return t === type;
  }) || null;
}

/* tag de saúde de uma fonte: {cls, label} ou null quando ok/sem dados */
function sourceHealthTag(type) {
  var s = sourceStatusFor(type);
  if (!s) return null;
  var estado = s.estado || (s.ok === false ? 'erro' : (s.last_run ? 'ok' : 'aguardando_primeira_indexacao'));
  if (estado === 'erro') return { cls: 'warn', label: 'erro de sync' };
  var h = ageHours(s.last_run);
  if (isFinite(h) && h > 48) return { cls: 'warn', label: 'sem sync há ' + Math.floor(h / 24) + ' dias' };
  return null;
}

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
    var ntHealth = workspaces.length ? sourceHealthTag('notion') : null;
    if (ntHealth) {
      ntTag.textContent = ntHealth.label;
      ntTag.className = 'tag ' + ntHealth.cls;
    } else {
      ntTag.textContent = workspaces.length
        ? (workspaces.length > 1 ? workspaces.length + ' workspaces' : 'conectado')
        : 'desconectado';
      ntTag.className = 'tag ' + (workspaces.length ? 'ok' : 'off');
    }
  }
  var nList = document.getElementById('notion-list');
  if (nList) {
    var ws = notion.workspaces || [];
    nList.innerHTML = ws.length
      ? ws.map(function (w) {
          var name = w.name || w.workspace || '(workspace)';
          var when = w.connected_at ? 'conectado em ' + new Date(w.connected_at).toLocaleDateString('pt-BR') : '';
          var connChip = w.connection_type === 'pat' ? '<span class="tag">Token (PAT)</span>' : w.connection_type === 'oauth' ? '<span class="tag">OAuth</span>' : '';
          return '<div class="kv-row"><span class="k">' + srcIcon('notion') + escapeHtml(name) + '</span>' +
            '<span class="v muted" style="font-size:12.5px">' + escapeHtml(when) + '</span>' +
            connChip +
            '<button class="link-quiet" type="button" data-rm-notion="' + escapeHtml(w.workspace || name) + '">remover</button></div>';
        }).join('')
      : '<p class="muted">Nenhum workspace conectado ainda. O Notion costuma ser a fonte mais rica do cerebro.</p>';
  }

  /* fontes-count + badge: contagem por tipo, não só o número de tipos */
  var bd = sourcesBreakdown(me);
  var fcEl = document.getElementById('fontes-count');
  if (fcEl) fcEl.textContent = bd.total ? '· ' + (bd.label || bd.total + ' conectadas') : '';
  var nbEl = document.getElementById('nav-fontes-badge');
  if (nbEl) nbEl.textContent = bd.total;

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
          return '<div class="kv-row"><span class="k">' + srcIcon('calendar') + escapeHtml(em) + '</span>' +
            '<span class="v muted" style="font-size:12.5px">leitura e escrita de eventos</span>' +
            '<button class="link-quiet" type="button" data-rm-google="' + escapeHtml(em) + '">desconectar</button></div>';
        }).join('')
      : '<p class="muted">Nenhuma conta conectada.</p>';
  }

  /* ical (card secundário, colapsado por padrão; abre sozinho quando já há links) */
  var icalLinks = (sources.ical && sources.ical.links) || [];
  var icalCard = document.getElementById('ical-card');
  if (icalCard && !icalCard._autoOpened && icalLinks.length) {
    icalCard.open = true;
    icalCard._autoOpened = true; /* só na primeira render — depois respeita o usuário */
  }
  var icTag = document.getElementById('ical-tag');
  if (icTag) {
    icTag.textContent = icalLinks.length
      ? icalLinks.length + (icalLinks.length > 1 ? ' agendas' : ' agenda')
      : 'nenhuma agenda';
    icTag.className = 'tag ' + (icalLinks.length ? 'ok' : '');
  }
  var iList = document.getElementById('ical-list');
  if (iList) {
    iList.innerHTML = icalLinks.length
      ? icalLinks.map(function (c) {
          return '<div class="kv-row"><span class="k">' + srcIcon('calendar') + escapeHtml(c.label || 'Sem nome') + '</span>' +
            '<span class="v masked">' + escapeHtml(c.masked_url || c.url || '') + '</span>' +
            '<button class="link-quiet" type="button" data-rm-ical="' + escapeHtml(String(c.id)) + '">remover</button></div>';
        }).join('')
      : '<p class="muted">Nenhum calendario por link ainda.</p>';
  }

  /* granola */
  var granola = sources.granola || {};
  var grHealth = granola.set ? sourceHealthTag('granola') : null;
  var grTag = document.getElementById('granola-tag');
  if (grTag) {
    if (grHealth) {
      grTag.textContent = grHealth.label;
      grTag.className = 'tag ' + grHealth.cls;
    } else {
      grTag.textContent = granola.set ? 'chave salva' : 'sem chave';
      grTag.className = 'tag ' + (granola.set ? 'ok' : '');
    }
  }
  /* notice warn acionável quando o Granola está em erro/stale */
  var grNotice = document.getElementById('granola-notice');
  if (grNotice) {
    if (grHealth) {
      grNotice.classList.remove('hidden');
      grNotice.textContent = grHealth.label === 'erro de sync'
        ? 'A sincronização do Granola falhou. A chave pode ter expirado — cole uma nova chave abaixo para retomar.'
        : 'Granola ' + grHealth.label + '. A chave pode ter expirado — cole uma nova chave abaixo; suas reuniões recentes serão indexadas na próxima sincronização.';
    } else {
      grNotice.classList.add('hidden');
      grNotice.textContent = '';
    }
  }
  var grState = document.getElementById('granola-state');
  if (grState) {
    grState.innerHTML = granola.set
      ? '<div class="kv-row"><span class="k">' + srcIcon('granola') + 'Chave da API</span>' +
        '<span class="v masked">' + escapeHtml(granola.masked || '••••') + '</span>' +
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

/* ==================== FONTES: CARD "TAREFAS NO NOTION" ====================
   A base de tarefas era configurável só no onboarding/ativação; este card dá
   visibilidade permanente e permite TROCAR a base depois (reusa os endpoints
   /portal/tasks/detect|use|create e a delegação global data-tasks-*). */

async function loadTasksCard(me) {
  var card = document.getElementById('tasks-card');
  if (!card) return;
  var notionConnected = !!(me && me.sources && me.sources.notion && me.sources.notion.connected);
  if (notionConnected) await loadTasksInfo();
  renderTasksCard(notionConnected);
}

function renderTasksCard(notionConnected) {
  var card = document.getElementById('tasks-card');
  if (!card) return;
  var tag = document.getElementById('tasks-tag');
  var state = document.getElementById('tasks-config-state');
  var info = window._tasksInfo;

  if (!notionConnected) {
    if (tag) { tag.textContent = 'requer Notion'; tag.className = 'tag'; }
    if (state) state.innerHTML = '<p class="muted">Conecte um workspace do Notion acima para configurar onde suas tarefas vivem.</p>';
    _tasksMsg('');
    _tasksActions('');
    return;
  }

  if (info && info.configured) {
    if (tag) { tag.textContent = 'configurada'; tag.className = 'tag ok'; }
    if (state) {
      var baseLink = isHttpUrl(info.url)
        ? '<a href="' + escapeHtml(info.url) + '" target="_blank" rel="noopener">' + escapeHtml(info.title || 'Tarefas') + '</a>'
        : '<strong>' + escapeHtml(info.title || 'Tarefas') + '</strong>';
      var nMissing = (info.missing || []).length;
      state.innerHTML = '<div class="kv-row"><span class="k">Base configurada</span>' +
        '<span class="v">' + baseLink + '</span>' +
        (nMissing ? '<span class="tag warn">' + nMissing + ' campo(s) sem correspondência</span>' : '<span class="tag ok">ativa</span>') +
        '</div>';
    }
    _tasksMsg('');
    _tasksActions('<button class="btn btn-ghost btn-sm" type="button" data-tasks-detect>Trocar de base</button>');
    return;
  }

  if (tag) { tag.textContent = 'não configurada'; tag.className = 'tag warn'; }
  if (state) state.innerHTML = '';
  _tasksMsg('Aponte uma base que você já tem ou crie o Kanban padrão Zinom — a página "🧠 Zinom" com a base "Tarefas" é criada no topo do seu workspace do Notion.');
  _tasksActions(
    '<button class="btn btn-ghost btn-sm" type="button" data-tasks-detect>Já tenho uma base no Notion</button>' +
    '<button class="btn btn-ghost btn-sm" type="button" data-tasks-create>Criar o Kanban padrão Zinom</button>'
  );
}

/* ==================== FONTES: NUDGE DE PRÓXIMO PASSO ====================  */

/**
 * Mostra nudge contextual na view Fontes:
 * - Se há ≥1 fonte indexada mas nenhuma IA conectada → "Conecte sua IA"
 * - Se IA conectada → "Faça sua primeira pergunta"
 */
function renderFontesNudge(me) {
  var nudge = document.getElementById('fontes-nudge');
  if (!nudge) return;

  var hasIndexedSources = false;
  if (me && me.sources) {
    var s = me.sources;
    hasIndexedSources = !!(
      (s.notion && s.notion.connected) ||
      (s.google && s.google.length) ||
      (s.ical && s.ical.links && s.ical.links.length) ||
      (s.granola && s.granola.set)
    );
  }

  var hasAi = assistants.length > 0;

  if (!hasIndexedSources) {
    nudge.classList.add('hidden');
    nudge.innerHTML = '';
    return;
  }

  nudge.classList.remove('hidden');
  if (!hasAi) {
    nudge.innerHTML =
      '<div class="nudge-card">' +
      '<span class="nudge-icon">✦</span>' +
      '<span class="nudge-text">Fontes prontas! Agora conecte sua IA favorita para começar a perguntar.</span>' +
      '<button class="btn btn-primary btn-sm" type="button" data-nav="guia" data-guia="conectar">Conectar minha IA →</button>' +
      '</div>';
  } else {
    nudge.innerHTML =
      '<div class="nudge-card">' +
      '<span class="nudge-icon">✓</span>' +
      '<span class="nudge-text">IA conectada e fontes prontas — faça sua primeira pergunta!</span>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-nav="consultar">Consultar o cérebro →</button>' +
      '</div>';
  }
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

var PAGE = 50;
var statusPollTimer = null;
/* E2.3: last counts from /portal/status for filter button rendering */
var _lastStatusCounts = null;

function stopStatusPolling() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

/* /portal/status falhou: deriva o estado do Início só de /portal/me para a home
   não ficar em branco; um loadStatus bem-sucedido depois re-deriva normalmente. */
function markStatusUnavailable() {
  window._statusUnavailable = true;
  if (!window._lastStatus) updateZState();
}

async function loadStatus() {
  var st;
  try {
    var res = await api('/portal/status');
    if (!res.ok) { markStatusUnavailable(); return; }
    st = await res.json();
  } catch (e) { markStatusUnavailable(); return; }

  window._statusUnavailable = false;
  window._lastStatus = st;
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
    /* fontes ativas = fontes REAIS (workspace, conta, agenda) com docs indexados,
       não o número de source_types distintos */
    var nSrcActive = (st.sources || []).filter(function (s) { return (s.documents || 0) > 0; }).length;
    if (!nSrcActive) nSrcActive = bySource.filter(function (s) { return s.documents > 0; }).length;
    var lastAt2 = bySource.reduce(function (m, s) {
      return s.last_indexed_at && s.last_indexed_at > m ? s.last_indexed_at : m;
    }, '');
    var lastStr = lastAt2 ? relTime(lastAt2) : 'nunca';
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
        /* counts: prefer os campos VIVOS por fonte (brain_chunks); depois o blob do
           último run; nunca o total por source_type (repetia o mesmo número em
           todos os workspaces) */
        var cts = s.counts && typeof s.counts === 'object' ? s.counts : null;
        var docsN = (s.documents != null) ? s.documents
          : (cts && cts.documents != null) ? cts.documents : 0;
        var chunksN = (s.chunks != null) ? s.chunks
          : (cts && cts.chunks != null) ? cts.chunks : 0;
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
        var when = (estado === 'ok' && s.last_run) ? '<span class="meta">sincronizado ' + relTime(s.last_run) + '</span>' : '';
        return '<div class="row">' + srcIcon(t) +
          '<span class="grow"><span class="ttl">' + escapeHtml(displayName) + '</span>' +
          (errHtml || when) + '</span>' +
          '<span class="nums">' + fmt(docsN) + ' docs<br>' + fmt(chunksN) + ' trechos</span>' +
          '<span class="tag ' + tagCls + '">' + escapeHtml(tagLbl) + '</span>' +
          '</div>';
      }).join('');
    }
  }

  /* v2: estado do Início + saúde + pipeline do Guia derivam do status
     (updateZState já chama renderHello/renderHealth no estado ativado
      e renderOnboarding no estado novo) */
  updateZState();
  renderGuiaPipeline();
  /* tags de saúde por fonte na view Fontes */
  if (window._lastMe) renderFontes(window._lastMe);

  /* poll */
  if (busy) {
    if (!statusPollTimer) statusPollTimer = setInterval(loadStatus, 4000);
  } else if (statusPollTimer) {
    stopStatusPolling();
    load();
    loadBilling();
  }
}

/* pipeline com números reais (Guia → Como o Zinom funciona) */
function renderGuiaPipeline() {
  var st = window._lastStatus;
  var fEl = document.getElementById('guia-pl-fontes');
  var fSubEl = document.getElementById('guia-pl-fontes-sub');
  var cEl = document.getElementById('guia-pl-chunks');
  var aEl = document.getElementById('guia-pl-assist');
  var bd = window._lastMe ? sourcesBreakdown(window._lastMe) : null;
  if (fEl) fEl.textContent = bd ? String(bd.total) : '—';
  if (fSubEl && bd && bd.label) fSubEl.textContent = bd.label;
  if (cEl) cEl.textContent = st ? fmt(totalChunks(st)) : '—';
  if (aEl) aEl.textContent = String(assistants.length);
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

  // Tela cheia do explorador (Esc sai). cy.resize() recalcula o canvas do grafo.
  var fsBtn = document.getElementById('brain-fullscreen-btn');
  function setExplorerFullscreen(on) {
    var card = document.getElementById('brain-explorer');
    if (!card) return;
    card.classList.toggle('fullscreen', on);
    document.body.classList.toggle('explorer-fs', on);
    if (fsBtn) {
      fsBtn.classList.toggle('active', on);
      fsBtn.textContent = on ? '✕ Sair da tela cheia' : '⛶ Tela cheia';
    }
    if (_cy) setTimeout(function () { _cy.resize(); _cy.fit(undefined, 30); }, 60);
  }
  if (fsBtn) fsBtn.addEventListener('click', function () {
    setExplorerFullscreen(!document.getElementById('brain-explorer').classList.contains('fullscreen'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('explorer-fs')) setExplorerFullscreen(false);
  });

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
  { label: 'Conectar seu assistente (Claude, ChatGPT…)', go: 'guia-conectar', goLabel: 'conectar →' }
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
    /* estado de tarefas/notion antes de qualquer early-return: o onboarding
       (estado novo) também depende de _actTasksDone */
    _actNotionConnected = !!(sources && sources.notion && sources.notion.connected);
    _actTasksDone = !!(st.items && st.items.tasks);
    /* base configurada: busca nome/link/missing para o passo Tarefas e o diagnóstico */
    if (_actTasksDone) await loadTasksInfo();
    var wrap = document.getElementById('activation');
    if (!wrap) return;
    if (st.complete || st.dismissed) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
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

    /* Sub-fluxo inline de Tarefas: escolha dupla quando incompleto */
    if (isTasksStep && !_actDone[i]) {
      var inner = '';
      if (!_actNotionConnected) {
        inner = '<p class="muted" style="margin:0 0 0 28px;font-size:13px">Conecte seu Notion em Fontes primeiro.</p>';
      } else {
        inner = '<div style="margin:6px 0 2px 28px;display:flex;flex-direction:column;gap:6px">' +
          '<p class="muted js-tasks-msg" style="margin:0;font-size:13px">Aponte uma base que você já tem ou crie o Kanban padrão Zinom (status, prioridade, prazo, tipo fazer/cobrar).</p>' +
          '<div class="task-choice js-tasks-actions">' +
            '<button class="btn btn-ghost btn-sm" type="button" data-tasks-detect>Já tenho uma base no Notion</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-tasks-create>Criar o Kanban padrão Zinom</button>' +
          '</div>' +
        '</div>';
      }
      btn += inner;
    }

    /* Passo Tarefas configurado: nome/link da base + upgrade do template (003-tasks-v1) */
    if (isTasksStep && _actDone[i]) {
      var info = window._tasksInfo;
      if (info && info.configured) {
        var baseLink = isHttpUrl(info.url)
          ? '<a href="' + escapeHtml(info.url) + '" target="_blank" rel="noopener">' + escapeHtml(info.title || 'Tarefas') + '</a>'
          : '<strong>' + escapeHtml(info.title || 'Tarefas') + '</strong>';
        var upgradeBtn = (info.is_standard && info.missing && info.missing.length)
          ? '<button class="btn btn-ghost btn-sm" type="button" data-tasks-upgrade>Atualizar para o template novo</button>'
          : '';
        btn += '<div class="act-tasks-info">Base configurada: ' + baseLink + upgradeBtn + '</div>';
      }
    }
    return btn;
  }).join('');

  stepsEl.innerHTML = html + '<p class="muted" style="font-size:12px;margin:10px 0 0;padding-top:8px;border-top:1px solid var(--line);display:flex;gap:12px;flex-wrap:wrap">Dúvida de como usar? <button class="link-quiet" type="button" data-nav="guia" style="font-size:12px">Entenda como usar no Guia →</button><button class="link-quiet" type="button" id="activation-dismiss-btn" style="font-size:12px;margin-left:auto">dispensar checklist</button></p>';

  /* Botões de detect/create/use/upgrade usam delegação global (wireGlobal) */
  var dismissBtn = document.getElementById('activation-dismiss-btn');
  if (dismissBtn) dismissBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var wrap = document.getElementById('activation');
    if (wrap) wrap.classList.add('hidden');
    dismissActivation();
  });
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
  /* progresso REAL: o backend grava um run por fonte conforme termina; o poll
     de /portal/status mostra quantas fontes já concluíram — sem stepper fake */
  var isFirstIndex = !totalChunks(window._lastStatus);
  var noteEl = document.getElementById('index-note');
  if (noteEl) {
    noteEl.textContent = isFirstIndex
      ? 'Pode fechar esta página — a indexação continua no servidor e você recebe um e-mail quando a primeira terminar. Acompanhe fonte a fonte em Atividade.'
      : 'Pode fechar esta página — a indexação continua no servidor. Acompanhe fonte a fonte em Atividade.';
  }
  if (stepEl) stepEl.textContent = 'Indexação em andamento — isso pode levar vários minutos…';
  if (pctEl) pctEl.textContent = '';
  if (fillEl) fillEl.style.width = '4%';

  function tick() {
    var pollCount = 0;
    /* 4s × 300 = 20 min de acompanhamento; depois o servidor segue sozinho */
    var pollDone = setInterval(async function () {
      pollCount++;
      try {
        var r = await api('/portal/status');
        if (!r.ok) { clearInterval(pollDone); finishIndex(); return; }
        var s = await r.json();
        var srcs = s.sources || [];
        var doneN = srcs.filter(function (x) {
          return x.estado && x.estado !== 'indexando' && x.estado !== 'aguardando_primeira_indexacao';
        }).length;
        var totalN = srcs.length || 1;
        if (s.running) {
          if (stepEl) stepEl.textContent = 'Indexando suas fontes — ' + doneN + ' de ' + totalN + ' concluída' + (doneN === 1 ? '' : 's');
          var pct = Math.round((doneN / totalN) * 100);
          if (pctEl) pctEl.textContent = doneN ? pct + '%' : '';
          if (fillEl) fillEl.style.width = Math.max(4, pct) + '%';
        }
        if (!s.running) {
          clearInterval(pollDone);
          finishIndex(s);
        } else if (pollCount > 300) {
          clearInterval(pollDone);
          if (stepEl) stepEl.textContent = 'A indexação continua no servidor — acompanhe em Atividade.';
          finishIndex(s);
        }
      } catch (e) {
        clearInterval(pollDone);
        finishIndex(null);
      }
    }, 4000);
  }

  function finishIndex(statusData) {
    indexing = false;
    if (btn) btn.disabled = false;
    if (bar) bar.classList.add('hidden');
    if (subEl) subEl.classList.remove('hidden');
    if (itag) itag.classList.add('hidden');
    /* Mostrar mensagem de conclusão com stats */
    var doneEl = document.getElementById('index-done-msg');
    if (doneEl) {
      var totals = (statusData && statusData.counts && statusData.counts.totals) || {};
      var docs = totals.documents || 0;
      var chunks = totals.chunks || 0;
      if (docs > 0 || chunks > 0) {
        doneEl.innerHTML =
          'Pronto: <strong>' + fmt(docs) + ' documentos</strong> · <strong>' + fmt(chunks) + ' trechos</strong> indexados. ' +
          '<button class="link-quiet" type="button" data-nav="atividade">Ver Atividade →</button>';
        doneEl.classList.remove('hidden');
        /* Ocultar após 12s */
        setTimeout(function () { doneEl.classList.add('hidden'); }, 12000);
      } else {
        doneEl.classList.add('hidden');
      }
    }
    /* recarregar status e dados */
    if (statusData) {
      window._lastStatus = statusData;
      renderBrainMini(false, statusData);
      /* usuário novo: sai do onboarding assim que a 1ª indexação termina */
      updateZState();
    } else {
      loadStatus();
    }
    load();
    loadBilling();
    /* explorador liberado/atualizado assim que a indexação termina */
    try {
      loadBrain(true);
      loadEntities();
      if (explorerState.view === 'grafo') reloadGraph();
    } catch (e) { /* explorador indisponível neste ambiente */ }
  }

  tick();
}

/* ==================== CONEXÃO GUIADA (Parte A) ====================  */

/** Preenche todas as ocorrências de endpoint-block nos painéis guiados com a URL real. */
function fillGuidedEndpoints(mcpUrl) {
  var url = mcpUrl || 'https://zinom.ai/mcp';
  ['endpoint-claudeai', 'endpoint-chatgpt', 'endpoint-outra'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    /* Preserva o botão de copiar, atualiza só o texto nó e o data-copy */
    var btn = el.querySelector('.copy-btn');
    el.textContent = url;
    if (btn) {
      btn.setAttribute('data-copy', url);
      el.appendChild(btn);
    }
  });
}

/** Exibe/oculta o selo "Sua IA já está conectada" com base nos tokens. */
function renderConnectActiveBadge() {
  var badge = document.getElementById('connect-active-badge');
  if (!badge) return;
  /* Considera ativo se há algum token (last_used_at ou apenas existência) */
  var hasActive = assistants.length > 0;
  badge.classList.toggle('hidden', !hasActive);
}

/** Troca a aba ativa na seção de conexão guiada. */
function switchAiTab(aiKey) {
  document.querySelectorAll('.ai-tab').forEach(function (t) {
    var isActive = t.getAttribute('data-ai') === aiKey;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('.ai-panel').forEach(function (p) {
    var isActive = p.id === 'ai-panel-' + aiKey;
    p.classList.toggle('active', isActive);
    if (isActive) { p.removeAttribute('hidden'); } else { p.setAttribute('hidden', ''); }
  });
}

function wireAiTabs() {
  document.querySelectorAll('.ai-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchAiTab(tab.getAttribute('data-ai'));
    });
  });

  /* Botão de token para ChatGPT (espelha o token principal) */
  var tgenChatgpt = document.getElementById('token-gen-btn-chatgpt');
  if (tgenChatgpt) tgenChatgpt.addEventListener('click', function () { generateTokenFor('chatgpt'); });

  /* Botão de token para Outra IA */
  var tgenOutra = document.getElementById('token-gen-btn-outra');
  if (tgenOutra) tgenOutra.addEventListener('click', function () { generateTokenFor('outra'); });

  /* copy-test-prompt: botões com data-copy já são tratados pelo handler global de .copy-btn via data-copy;
     usamos a classe copy-test-prompt para feedback visual diferenciado */
  document.body.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-test-prompt');
    if (!btn) return;
    var txt = btn.getAttribute('data-copy');
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(function () {
        var orig = btn.textContent;
        btn.textContent = 'Copiado ✓';
        setTimeout(function () { btn.textContent = orig; }, 1800);
        toast('Prompt copiado!');
      })
      .catch(function () { toast('Selecione e copie manualmente'); });
  });
}

/** Gera token e renderiza no painel indicado ('chatgpt' ou 'outra'). */
async function generateTokenFor(panel) {
  var areaId = panel === 'chatgpt' ? 'token-area-chatgpt' : 'token-area-outra';
  var btnId = panel === 'chatgpt' ? 'token-gen-btn-chatgpt' : 'token-gen-btn-outra';
  var area = document.getElementById(areaId);
  var btn = document.getElementById(btnId);
  /* label conforme a aba; backend pode ignorar o body sem quebrar nada */
  var label = panel === 'chatgpt' ? 'ChatGPT' : 'Outra IA';
  var res;
  try {
    res = await apiJSON('/portal/mcp-token', 'POST', { label: label });
  } catch (e) { toast('Erro de rede ao gerar token.'); return; }
  if (!res.ok) { toast('Não consegui gerar o token.'); return; }
  var data = await res.json();
  var token = data.token;
  var mcpUrl = data.mcp_url || 'https://zinom.ai/mcp';
  /* Atualiza todos os endpoints dos painéis */
  fillGuidedEndpoints(mcpUrl);
  if (area) {
    area.innerHTML =
      '<div class="token-reveal">' +
      '<div class="meter-head" style="margin-bottom:7px"><strong>Seu token pessoal</strong><span class="tag warn">aparece só uma vez</span></div>' +
      '<div class="tk">' + escapeHtml(token) + '</div>' +
      '<button class="btn btn-ghost btn-sm mt-sm" type="button" data-copy-token="' + escapeHtml(token) + '">Copiar token</button>' +
      '</div>' +
      '<p class="muted mt-sm" style="font-size:12.5px">Use esse token no cabeçalho <code>Authorization: Bearer &lt;token&gt;</code>.</p>';
  }
  if (btn) btn.textContent = 'Gerar novo token';
  await loadMcpTokens();
  renderInicio(window._lastMe, window._lastBilling);
}

/* ==================== DIAGNÓSTICO (Guia → Verificar agora) ====================
   Client-side: /portal/me + /portal/status + /portal/mcp-tokens.
   Linhas: sessão, fontes, última indexação, conexão MCP, +1 por fonte problemática. */

var diagRunning = false;

function buildDiagRows() {
  var me = window._lastMe;
  var st = window._lastStatus;
  var rows = [];

  rows.push({
    label: 'Sessão e conta',
    result: me && me.email ? 'ok' : 'warn',
    meta: (me && me.email) || 'sessão não confirmada'
  });

  var nSrc = countSources(me);
  rows.push({
    label: 'Fontes conectadas',
    result: nSrc > 0 ? 'ok' : 'warn',
    meta: nSrc > 0 ? nSrc + (nSrc > 1 ? ' fontes conectadas' : ' fonte conectada') : 'nenhuma fonte ainda',
    fix: nSrc > 0 ? null : { nav: 'fontes', text: 'Conecte sua primeira fonte em Fontes →' }
  });

  var chunks = totalChunks(st);
  var last = lastIndexedAt(st);
  rows.push({
    label: 'Última indexação',
    result: chunks > 0 ? 'ok' : 'warn',
    meta: chunks > 0 ? (last ? relTime(last) + ' · ' : '') + fmt(chunks) + ' trechos' : 'nunca indexado',
    fix: chunks > 0 ? null : { nav: 'fontes', text: 'Rode "Indexar agora" em Fontes →' }
  });

  /* Base de tarefas (003-tasks-v1): ok = configured via /portal/tasks/info;
     sem o endpoint (backend antigo), cai no item de ativação */
  var ti = window._tasksInfo;
  var tasksOk = ti ? !!ti.configured : _actTasksDone;
  rows.push({
    label: 'Base de tarefas',
    result: tasksOk ? 'ok' : 'warn',
    meta: tasksOk ? ((ti && ti.title) || 'configurada') : 'não configurada',
    fix: tasksOk ? null : { nav: 'inicio', text: 'Configure sua base de tarefas no Início →' }
  });

  var used = assistants.filter(function (t) { return !!t.last_used_at; }).length;
  rows.push({
    label: 'Conexão MCP',
    result: used > 0 ? 'ok' : 'warn',
    meta: used > 0
      ? used + (used > 1 ? ' assistentes ativos' : ' assistente ativo')
      : (assistants.length ? 'token gerado, nunca usado' : 'nenhuma IA conectada'),
    fix: used > 0 ? null : { guia: 'conectar', text: 'Conecte sua IA em Conectar sua IA (acima) →' }
  });

  ((st && st.sources) || []).forEach(function (s) {
    var name = s.display_name || s.source || s.source_type || 'Fonte';
    var estado = s.estado || (s.ok === false ? 'erro' : (s.last_run ? 'ok' : 'aguardando_primeira_indexacao'));
    var h = ageHours(s.last_run);
    if (estado === 'erro') {
      rows.push({ label: name, result: 'warn', meta: 'erro de sincronização',
        fix: { nav: 'fontes', text: 'Corrigir ' + name + ' em Fontes →' } });
    } else if (isFinite(h) && h > 48) {
      rows.push({ label: name, result: 'warn', meta: 'sem sync há ' + Math.floor(h / 24) + ' dias',
        fix: { nav: 'fontes', text: 'Corrigir ' + name + ' em Fontes →' } });
    }
  });

  return rows;
}

function wireDiag() {
  var diagBtn = document.getElementById('diag-btn');
  if (!diagBtn) return;
  diagBtn.addEventListener('click', async function () {
    if (diagRunning) return;
    diagRunning = true;
    diagBtn.disabled = true;
    var list = document.getElementById('diag-list');
    var fix = document.getElementById('diag-fix');
    if (fix) { fix.classList.add('hidden'); fix.innerHTML = ''; }

    /* dados frescos (best-effort: cai no cache em falha) */
    try {
      var results = await Promise.allSettled([
        api('/portal/me').then(function (r) { return r.ok ? r.json() : null; }),
        api('/portal/status').then(function (r) { return r.ok ? r.json() : null; }),
        loadMcpTokens(),
        loadTasksInfo()
      ]);
      if (results[0].status === 'fulfilled' && results[0].value) window._lastMe = Object.assign({}, window._lastMe, results[0].value);
      if (results[1].status === 'fulfilled' && results[1].value) window._lastStatus = results[1].value;
    } catch (e) { /* usa cache */ }

    var rows = buildDiagRows();
    if (list) {
      list.classList.remove('hidden');
      list.innerHTML = rows.map(function (r) {
        return '<div class="diag-row pend"><span class="ds">' + (r.result === 'ok' ? '✓' : '!') + '</span>' +
          '<span class="grow">' + escapeHtml(r.label) + '</span><span class="dm">—</span></div>';
      }).join('');
    }

    var els = list ? Array.prototype.slice.call(list.querySelectorAll('.diag-row')) : [];
    var i = 0;
    function step() {
      if (i > 0 && els[i - 1]) {
        els[i - 1].className = 'diag-row ' + rows[i - 1].result;
        els[i - 1].querySelector('.dm').textContent = rows[i - 1].meta;
      }
      if (i >= els.length) {
        diagRunning = false;
        diagBtn.disabled = false;
        diagBtn.textContent = 'Verificar de novo';
        var warns = rows.filter(function (r) { return r.result === 'warn'; });
        if (fix && warns.length) {
          var first = warns.find(function (r) { return r.fix; }) || warns[0];
          var link = '';
          if (first.fix) {
            link = first.fix.guia
              ? ' <a href="#guia" data-nav="guia" data-guia="' + first.fix.guia + '">' + escapeHtml(first.fix.text) + '</a>'
              : ' <a href="#' + first.fix.nav + '" data-nav="' + first.fix.nav + '">' + escapeHtml(first.fix.text) + '</a>';
          }
          fix.innerHTML = warns.length + (warns.length > 1 ? ' pendências encontradas.' : ' pendência encontrada.') + link;
          fix.classList.remove('hidden');
        } else if (fix) {
          fix.classList.add('hidden');
        }
        return;
      }
      els[i].className = 'diag-row run';
      i++;
      setTimeout(step, 550);
    }
    step();
  });
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
    /* botão vive no painel Claude Code; backend pode ignorar o body sem quebrar nada */
    res = await apiJSON('/portal/mcp-token', 'POST', { label: 'Claude Code' });
  } catch (e) { toast('Erro de rede ao gerar token.'); return; }
  if (!res.ok) { toast('Não consegui gerar o token.'); return; }
  var data = await res.json();
  var token = data.token;
  var mcpUrl = data.mcp_url || 'https://zinom.ai/mcp';
  /* -s user: o Zinom fica disponível em todas as pastas, não só na atual */
  var cmd = 'claude mcp add -s user --transport http zinom \\\n  ' + mcpUrl + ' \\\n  --header "Authorization: Bearer ' + token + '"';
  var cmdBlock = '<div class="code-block">' + escapeHtml(cmd).replace('claude', '<span class="hl">claude</span>') +
    '<button class="copy-btn" type="button" data-copy="' + escapeHtml(cmd.replace(/\n/g, ' ').replace(/\\ /g, '')) + '">copiar</button></div>';
  var area = document.getElementById('token-area');
  if (area) {
    area.innerHTML =
      '<div class="token-reveal">' +
      '<div class="meter-head" style="margin-bottom:7px"><strong>Seu token pessoal</strong><span class="tag warn">aparece so uma vez</span></div>' +
      '<div class="tk">' + escapeHtml(token) + '</div>' +
      '<button class="btn btn-ghost btn-sm mt-sm" type="button" data-copy-token="' + escapeHtml(token) + '">Copiar token</button>' +
      '</div>';
  }
  /* comando real no passo "Colar no terminal" (substitui o exemplo com <token>) */
  var cmdArea = document.getElementById('cc-cmd-area');
  if (cmdArea) {
    cmdArea.innerHTML = cmdBlock;
  } else if (area) {
    /* fallback: layout antigo sem o passo dedicado */
    area.innerHTML += '<label class="mt-md">Claude Code — cole no terminal:</label>' + cmdBlock;
  }
  /* Atualiza endpoints nos demais painéis guiados */
  fillGuidedEndpoints(mcpUrl);
  var genBtn = document.getElementById('token-gen-btn');
  if (genBtn) genBtn.textContent = 'Gerar novo token';
  /* recarregar lista de tokens */
  await loadMcpTokens();
  renderInicio(window._lastMe, window._lastBilling);
}

/* ==================== CONSULTAR (ex Chat de teste) ====================  */

var chatBusy = false;
// E3: histórico de conversa (últimas 6 mensagens, gerenciado no cliente)
var chatHistory = [];

/* ---- histórico de consultas (localStorage, sem backend) ----
   chave zinom_consults_v1: array de {id, title, msgs, ts, history}
   msgs: {role:'user', text} | {role:'ai', html} | {role:'block', html} */
var CONV_KEY = 'zinom_consults_v1';
var CONV_MAX = 20;
var currentConvId = null;

function loadConvs() {
  try {
    var raw = localStorage.getItem(CONV_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveConvs(convs) {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(convs.slice(0, CONV_MAX))); } catch (e) { /* quota */ }
}

function renderConvRail() {
  var listEl = document.getElementById('conv-list');
  if (!listEl) return;
  var convs = loadConvs();
  listEl.innerHTML = convs.map(function (c) {
    return '<button class="conv-item' + (c.id === currentConvId ? ' active' : '') + '" type="button" data-conv-id="' + escapeHtml(String(c.id)) + '">' +
      escapeHtml(c.title || 'Consulta') + '<span class="cm">' + escapeHtml(relTime(c.ts)) + '</span></button>';
  }).join('');
}

/* salva/atualiza a conversa atual ao receber resposta */
function appendToCurrentConv(q, aiHtml, role) {
  var convs = loadConvs();
  var conv = null;
  if (currentConvId) conv = convs.find(function (c) { return c.id === currentConvId; }) || null;
  if (!conv) {
    conv = {
      id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
      title: String(q || 'Consulta').slice(0, 48),
      msgs: [],
      ts: Date.now()
    };
    convs.unshift(conv);
    currentConvId = conv.id;
  }
  if (q != null) conv.msgs.push({ role: 'user', text: q });
  /* guarda a pergunta junto da resposta para religar o feedback com a query real */
  if (aiHtml != null) conv.msgs.push({ role: role || 'ai', html: aiHtml, q: q != null ? String(q) : '' });
  conv.ts = Date.now();
  conv.history = chatHistory.slice(-12);
  convs = [conv].concat(convs.filter(function (c) { return c.id !== conv.id; }));
  saveConvs(convs);
  renderConvRail();
}

function startNewConsult() {
  currentConvId = null;
  chatHistory = [];
  var threadEl = document.getElementById('thread');
  var emptyEl = document.getElementById('chat-empty');
  if (threadEl) { threadEl.innerHTML = ''; threadEl.classList.add('hidden'); }
  if (emptyEl) emptyEl.classList.remove('hidden');
  renderConvRail();
}

/* Botões de action-card/capture-card não têm listener depois do restore:
   desabilita com visual claro para não parecerem vivos. (cite-n e fb-btn são
   religados; copy-btn e data-nav usam delegação global, então continuam vivos.) */
function neutralizeRestoredButtons(scope) {
  scope.querySelectorAll('.action-confirm, .action-cancel, [data-retry], .capture-card button').forEach(function (b) {
    b.disabled = true;
    b.classList.add('restored-off');
    b.title = 'Disponível só na consulta original';
  });
}

function restoreConv(id) {
  var conv = loadConvs().find(function (c) { return c.id === id; });
  if (!conv) return;
  currentConvId = id;
  chatHistory = (conv.history || []).slice();
  var threadEl = document.getElementById('thread');
  var emptyEl = document.getElementById('chat-empty');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (!threadEl) return;
  threadEl.classList.remove('hidden');
  threadEl.innerHTML = '';
  (conv.msgs || []).forEach(function (m) {
    if (m.role === 'user') {
      var u = document.createElement('div');
      u.className = 'msg-user';
      u.innerHTML = '<div class="q"></div>';
      u.querySelector('.q').textContent = m.text || '';
      threadEl.appendChild(u);
      return;
    }
    if (m.role === 'block') {
      var holder = document.createElement('div');
      holder.innerHTML = m.html || '';
      neutralizeRestoredButtons(holder);
      while (holder.firstChild) threadEl.appendChild(holder.firstChild);
      return;
    }
    var ai = document.createElement('div');
    ai.className = 'msg-ai';
    ai.innerHTML = '<span class="av">' + logoSvg(30) + '</span><div class="stack">' + (m.html || '') + '</div>';
    var stack = ai.querySelector('.stack');
    wireCiteRefs(stack);
    wireFeedbackBtns(stack, m.q || ''); // religa o feedback com a query original
    neutralizeRestoredButtons(stack);
    threadEl.appendChild(ai);
  });
  renderConvRail();
  scrollBottom();
}

/* ---- captura de URL (POST /portal/index-web — não passa pelo /portal/ask) ---- */
async function captureUrl(url) {
  if (chatBusy) return;
  chatBusy = true;

  var emptyEl = document.getElementById('chat-empty');
  var threadEl = document.getElementById('thread');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (threadEl) threadEl.classList.remove('hidden');

  var userEl = document.createElement('div');
  userEl.className = 'msg-user';
  userEl.innerHTML = '<div class="q"></div>';
  userEl.querySelector('.q').textContent = url;
  if (threadEl) threadEl.appendChild(userEl);

  var card = document.createElement('div');
  card.className = 'capture-card';
  var shortUrl = url.replace(/^https?:\/\//, '').slice(0, 60);
  card.innerHTML = '<span class="si">' + ICONS.web + '</span>' +
    '<span class="grow">Indexando <strong>' + escapeHtml(shortUrl) + '</strong> no seu cérebro…</span>';
  if (threadEl) threadEl.appendChild(card);
  scrollBottom();

  var grow = card.querySelector('.grow');
  try {
    var res = await apiJSON('/portal/index-web', 'POST', { url: url });
    var data = await res.json().catch(function () { return {}; });
    if (res.ok && data.ok !== false) {
      grow.innerHTML = 'Página indexada ✓ — ' +
        (data.title ? '<strong>' + escapeHtml(data.title) + '</strong> ' : '') +
        'já pesquisável por você e pelos seus assistentes.';
    } else if (res.status === 402) {
      card.classList.add('err');
      grow.innerHTML = 'Limite de páginas indexadas do seu plano atingido. <a href="/plano.html">Ver planos →</a>';
    } else {
      card.classList.add('err');
      grow.innerHTML = 'Não consegui indexar essa página' + (data.error ? ' (' + escapeHtml(String(data.error)) + ')' : '') + '. Verifique a URL e tente de novo.';
    }
  } catch (e) {
    card.classList.add('err');
    grow.innerHTML = 'Sem conexão — não consegui indexar agora. Tente de novo.';
  } finally {
    chatBusy = false;
    appendToCurrentConv(url, card.outerHTML, 'block');
    scrollBottom();
  }
}
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
        appendToCurrentConv(q || resumo, stack.innerHTML);
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
    appendToCurrentConv(q || resumo, stack.innerHTML);
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

// Frente C (#98): barra de feedback por resposta gerada — "Essa resposta foi
// útil?" vota em todos os chunks citados de uma vez via POST /portal/feedback.
// Reusa o mesmo votedChunks (1 voto por chunk por sessão de chat); desabilita
// após o voto; a consulta não é persistida em lugar nenhum além do POST.
function renderAnswerFeedback(sources) {
  var cited = (sources || []).filter(function (s) { return s.cited && s.chunk_id; });
  if (!cited.length) return '';
  return '<div class="answer-fb" data-answer-fb>' +
    '<span class="answer-fb-label">Essa resposta foi útil?</span>' +
    '<button class="fb-btn" type="button" data-afb-up title="Util" aria-label="Resposta util">&#128077;</button>' +
    '<button class="fb-btn" type="button" data-afb-down title="Nao util" aria-label="Resposta nao util">&#128078;</button>' +
    '</div>';
}

function wireAnswerFeedback(scope, sources, currentQuery) {
  var bar = scope.querySelector('[data-answer-fb]');
  if (!bar) return;
  var cited = (sources || []).filter(function (s) { return s.cited && s.chunk_id; });
  function vote(isUp) {
    bar.querySelectorAll('.fb-btn').forEach(function (b) { b.disabled = true; });
    cited.forEach(function (s) {
      if (votedChunks[s.chunk_id]) return; // 1 voto por chunk por sessão
      votedChunks[s.chunk_id] = true;
      apiJSON('/portal/feedback', 'POST', {
        chunk_id: s.chunk_id,
        value: isUp ? 'up' : 'down',
        query: currentQuery || ''
      }).catch(function () {});
    });
  }
  var up = bar.querySelector('[data-afb-up]');
  var down = bar.querySelector('[data-afb-down]');
  if (up) up.addEventListener('click', function () { vote(true); });
  if (down) down.addEventListener('click', function () { vote(false); });
}

function scrollBottom() {
  var se = document.scrollingElement;
  se.scrollTo({ top: se.scrollHeight, behavior: 'smooth' });
}

async function ask(q) {
  if (!q || chatBusy) return;

  /* mensagem que é só uma URL http(s) → indexa via /portal/index-web */
  if (/^https?:\/\/\S+$/i.test(q.trim())) { captureUrl(q.trim()); return; }

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

    // Frente C (#98): modo degradado — LLM indisponível, mas a busca achou
    // fontes. Mostra o aviso + as fontes (com feedback por fonte).
    if (data.degraded) {
      stack.innerHTML = '<div class="chat-block degraded">' +
        '<span class="bh">A IA está temporariamente indisponível — aqui está o que encontrei no seu cérebro:</span>' +
        '</div>' + renderAskAnswer('', sources);
      wireCiteRefs(stack);
      wireFeedbackBtns(stack, q);
      scrollBottom();
      appendToCurrentConv(q, stack.innerHTML);
      return;
    }

    // E3: action route — show confirmation card
    if (route === 'action' && data.proposed_action) {
      renderActionCard(data.proposed_action, stack, q);
      scrollBottom();
      // Don't add to history until confirmed/cancelled (handled inside renderActionCard)
      return;
    }

    // meta or search route
    stack.innerHTML = renderAskAnswer(answer, route === 'meta' ? [] : sources) +
      (route === 'meta' ? '' : renderAnswerFeedback(sources)); // Frente C: "Essa resposta foi útil?"
    wireCiteRefs(stack);
    wireFeedbackBtns(stack, q); // Spec 004: wire 👍/👎 buttons
    wireAnswerFeedback(stack, sources, q);
    scrollBottom();

    // E3: atualiza histórico
    chatHistory.push({ role: 'user', content: q });
    chatHistory.push({ role: 'assistant', content: answer });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);

    // v2: salva/atualiza a conversa no histórico local
    appendToCurrentConv(q, stack.innerHTML);
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

  /* rail de conversas (desktop) */
  var convNew = document.getElementById('conv-new-btn');
  if (convNew) convNew.addEventListener('click', startNewConsult);
  var convList = document.getElementById('conv-list');
  if (convList) convList.addEventListener('click', function (e) {
    var b = e.target.closest('[data-conv-id]');
    if (b) restoreConv(b.getAttribute('data-conv-id'));
  });
  renderConvRail();
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

  /* navegacao (com suporte a deep-link data-guia="conectar" | "tarefas") */
  document.body.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (!nav) return;
    e.preventDefault();
    var guia = nav.getAttribute('data-guia');
    if (nav.getAttribute('data-nav') === 'guia' && guia) {
      goGuiaSection('guia-' + guia);
    } else {
      go(nav.getAttribute('data-nav'));
    }
  });

  /* tarefas: escolha dupla + usar base detectada + upgrade do template —
     delegação global porque os botões existem no onboarding E na ativação */
  document.body.addEventListener('click', function (e) {
    var td = e.target.closest('[data-tasks-detect]');
    if (td) { e.stopPropagation(); runDetectTasks(); return; }
    var tc = e.target.closest('[data-tasks-create]');
    if (tc) { e.stopPropagation(); runCreateTasks(); return; }
    var tu = e.target.closest('[data-use-tasks]');
    if (tu) { e.stopPropagation(); runUseTasks(tu.getAttribute('data-use-tasks')); return; }
    var up = e.target.closest('[data-tasks-upgrade]');
    if (up) { e.stopPropagation(); runUpgradeTasks(up); return; }
  });

  /* revogar token MCP (Início + Conta) e encerrar sessão (Conta) — delegação global */
  document.body.addEventListener('click', function (e) {
    var rmA = e.target.closest('[data-rm-assist]');
    if (rmA) { revokeAssistant(rmA.getAttribute('data-rm-assist')); return; }
    var rmS = e.target.closest('[data-rm-session]');
    if (rmS) { revokeSession(rmS.getAttribute('data-rm-session'), false); return; }
  });

  /* filtros de receitas (Guia) */
  var rfWrap = document.getElementById('recipe-filters');
  if (rfWrap) rfWrap.addEventListener('click', function (e) {
    var fchip = e.target.closest('.fchip');
    if (!fchip) return;
    var cat = fchip.getAttribute('data-rcat');
    rfWrap.querySelectorAll('.fchip').forEach(function (c2) { c2.classList.toggle('active', c2 === fchip); });
    document.querySelectorAll('#recipe-grid .recipe-card').forEach(function (card) {
      card.style.display = (cat === 'todas' || card.getAttribute('data-rcat') === cat) ? '' : 'none';
    });
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
      if (ACT_STEPS[i].go === 'guia-conectar') { goGuiaConectar(); return; }
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

/* ==================== TASKS (ativacao + onboarding) ====================
   Endpoints preservados do fluxo de ativacao original:
   /portal/tasks/detect, /portal/tasks/create, /portal/tasks/use,
   /portal/activation/ask, /portal/activation/dismiss
   Novos (003-tasks-v1): GET /portal/tasks/info, POST /portal/tasks/upgrade.
   A escolha dupla existe em duas superfícies (onboarding estado-novo e
   checklist de ativação) — os helpers escrevem em todas via classe.
   ===================================================================== */

function _tasksMsg(txt) {
  document.querySelectorAll('.js-tasks-msg').forEach(function (el) { el.textContent = txt; });
}

function _tasksActions(html) {
  document.querySelectorAll('.js-tasks-actions').forEach(function (el) { el.innerHTML = html; });
}

/* GET /portal/tasks/info → {configured, title, url, mapped, missing, is_standard}.
   Degrada para null quando o endpoint não existe/falha (backend antigo). */
async function loadTasksInfo() {
  try {
    var res = await api('/portal/tasks/info');
    if (!res.ok) { window._tasksInfo = null; return; }
    window._tasksInfo = await res.json();
  } catch (e) { window._tasksInfo = null; }
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
    _tasksMsg('Não encontrei base de tarefas. Quer que eu crie o Kanban padrão ("Zinom › Tarefas")?');
    _tasksActions('<button class="btn btn-ghost btn-sm" type="button" data-tasks-create>Criar o Kanban padrão Zinom</button>');
    return;
  }
  /* candidatos encontrados */
  _tasksMsg('Encontrei isto no seu Notion. Use uma, ou crie uma nova:');
  var btns = det.candidates.map(function (c) {
    return '<button class="btn btn-ghost btn-sm" type="button" data-use-tasks="' + escHtml(c.id) + '">Usar "' + escHtml(c.title) + '"</button>';
  }).join('');
  btns += '<button class="btn btn-ghost btn-sm" type="button" data-tasks-create>Criar nova</button>';
  _tasksActions(btns);
}

async function runCreateTasks() {
  _tasksMsg('Criando a página "🧠 Zinom" no topo do seu workspace do Notion, com a base "Tarefas" dentro…');
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
    var res = await apiJSON('/portal/tasks/use', 'POST', { data_source_id: dataSourceId });
    var info = await res.json().catch(function () { return null; });
    if (!res.ok) {
      /* 400 {error:'unreadable', message} — backend não conseguiu ler a base */
      var msg = (info && info.message) || (info && info.error) || 'Não consegui usar essa base. Tente novamente.';
      _tasksMsg(msg);
      return;
    }
    /* o /use retorna o shape do info: mostra o que mapeou/faltou */
    if (info && info.configured) {
      window._tasksInfo = info;
      var nMapped = (info.mapped || []).length;
      var nMissing = (info.missing || []).length;
      if (nMapped === 0) {
        toast('Base configurada' + (nMissing ? ' — ' + nMissing + ' campo(s) sem correspondência' : '') + '.');
      } else {
        toast('Base "' + (info.title || 'Tarefas') + '" configurada — ' + nMapped +
          (nMapped === 1 ? ' campo mapeado' : ' campos mapeados') +
          (nMissing ? ', ' + nMissing + ' sem correspondência' : '') + '.');
      }
    }
    load();
  } catch (e) {
    _tasksMsg('Erro ao salvar. Tente novamente.');
  }
}

/* POST /portal/tasks/upgrade — adiciona campos do template novo ao tracker padrão */
async function runUpgradeTasks(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Atualizando…'; }
  try {
    var res = await apiJSON('/portal/tasks/upgrade', 'POST');
    var b = await res.json().catch(function () { return {}; });
    if (res.ok && b.ok) {
      toast(b.added && b.added.length
        ? 'Template atualizado: ' + b.added.join(', ')
        : 'Template já estava atualizado.');
      await loadTasksInfo();
      renderActivation();
    } else {
      toast((b && b.error) || 'Não consegui atualizar o template.');
      if (btn) { btn.disabled = false; btn.textContent = 'Atualizar para o template novo'; }
    }
  } catch (e) {
    toast('Erro de rede ao atualizar o template.');
    if (btn) { btn.disabled = false; btn.textContent = 'Atualizar para o template novo'; }
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

  /* chamadas independentes em paralelo: google accounts, ativação e tokens MCP */
  me.sources = me.sources || {};
  var results = await Promise.all([
    api('/portal/google/accounts')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; }),
    loadActivation(me.sources),
    loadMcpTokens()
  ]);
  var googleAccounts = results[0] || [];
  me.sources.google = googleAccounts.map(function (a) { return a.email; });
  me.google_configured = me.google_configured !== false;

  renderFontes(me);
  loadTasksCard(me); /* assíncrono — card "Tarefas no Notion" em Fontes */
  renderConta(me);
  renderInicio(me, window._lastBilling);
  renderChatEmpty(me);
  renderGuiaPipeline();
  /* Preencher URLs nos painéis guiados com a URL real do servidor */
  var baseMcpUrl = (me && me.mcp && me.mcp.url) ? me.mcp.url
    : (me && me.mcp_url) ? me.mcp_url
    : (window.location.origin + '/mcp');
  fillGuidedEndpoints(baseMcpUrl);
  renderFontesNudge(me);
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
  wireAiTabs();
  wireDiag();
  applyTaskPrompts();

  /* rota inicial (suporta rota legada #chat e deep-links #guia-conectar / #guia-tarefas) */
  var hash = (location.hash || '#inicio').slice(1).split('?')[0];
  if (hash === 'guia-conectar' || hash === 'guia-tarefas') {
    goGuiaSection(hash);
  } else {
    var validViews = ['inicio', 'chat', 'fontes', 'atividade', 'consultar', 'guia', 'conta'];
    go(validViews.includes(hash) ? hash : 'inicio');
  }

  load();
  loadBilling();
  loadStatus();
  loadBrain(true);
  loadWeek();
  loadAiSearches();
  loadNextMeeting();
  loadSessions();
}

window.addEventListener('hashchange', function () {
  var h = (location.hash || '#inicio').slice(1).split('?')[0];
  if (h === 'guia-conectar' || h === 'guia-tarefas') { goGuiaSection(h); return; }
  var validViews = ['inicio', 'chat', 'fontes', 'atividade', 'consultar', 'guia', 'conta'];
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
