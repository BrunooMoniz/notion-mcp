/* Zinom landing — interactions (icons, tabs, nav, reveal, chat demo) + portal API wiring.
   Forms call the real portal endpoints (/portal/register, /portal/login,
   /portal/request-invite) with credentials so the session cookie round-trips. */
(function () {
  "use strict";

  const API = window.PORTAL_API_BASE || "";

  /* ---------- inline brand icons ---------- */
  const ICONS = {
    notion: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="19" height="19" rx="3.2" fill="#fff" stroke="#26241f" stroke-width="1.4"/><path d="M7 7.4 13.3 7l3.7 5.1V7.6" stroke="#26241f" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M7 7.4v9.2M17 7.6v9l-3.8-.5-3.5-4.9v5l-2.7-.4" stroke="#26241f" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    granola: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#F6C544"/><circle cx="12" cy="12" r="4.4" fill="#26241f"/><circle cx="12" cy="12" r="1.7" fill="#F6C544"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="#3A7BE0" stroke-width="1.7"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9h18M8 2.5v4M16 2.5v4" stroke-linecap="round"/><circle cx="8.5" cy="13.5" r="1.1" fill="#3A7BE0" stroke="none"/><circle cx="12" cy="13.5" r="1.1" fill="#3A7BE0" stroke="none"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="#827d73" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>',
    claude: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#D97757"/><g stroke="#fff" stroke-width="1.5" stroke-linecap="round"><path d="M12 6.4v11.2M7.15 8.4l9.7 7.2M16.85 8.4l-9.7 7.2"/></g></svg>',
    claudecode: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#26241f"/><path d="M7.6 9 10.6 12 7.6 15M12.8 15h3.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chatgpt: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#10A37F"/><path d="M12 5.4 18 8.9v6.2L12 18.6 6 15.1V8.9z" stroke="#fff" stroke-width="1.35" fill="none" stroke-linejoin="round"/><circle cx="12" cy="12" r="1.9" fill="#fff"/></svg>',
    cursor: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#16161a"/><path d="M8.7 7 16 11.6l-3.3.9-1.4 3.5z" fill="#fff"/></svg>',
    mcp: '<svg viewBox="0 0 24 24" fill="none" stroke="#827d73" stroke-width="1.6"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21M5.6 5.6l2.5 2.5M15.9 15.9l2.5 2.5M18.4 5.6l-2.5 2.5M8.1 15.9l-2.5 2.5" stroke-linecap="round"/></svg>',
    zinom: '<svg viewBox="0 0 24 24" fill="none"><rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="var(--accent)"/><path d="M7.5 7.5 H16.5 L7.5 16.5 H16.5" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7.5" cy="7.5" r="1.7" fill="#fff"/><circle cx="16.5" cy="7.5" r="1.7" fill="#fff"/><circle cx="7.5" cy="16.5" r="1.7" fill="#fff"/><circle cx="16.5" cy="16.5" r="1.7" fill="#fff"/></svg>'
  };
  document.querySelectorAll('[data-ic]').forEach(function (el) {
    const k = el.getAttribute('data-ic');
    if (ICONS[k]) el.innerHTML = ICONS[k];
    el.style.display = 'inline-flex';
  });

  /* ---------- nav shadow on scroll ---------- */
  const nav = document.getElementById('nav');
  const onScroll = function () {
    if (window.scrollY > 8) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- access tabs ---------- */
  const tabs = document.querySelectorAll('.tab');
  const panes = document.querySelectorAll('.pane');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      const name = tab.getAttribute('data-tab');
      tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      panes.forEach(function (p) {
        const on = p.getAttribute('data-pane') === name;
        p.classList.toggle('active', on);
        p.classList.remove('anim');
        if (on) { void p.offsetWidth; p.classList.add('anim'); }
      });
      document.querySelectorAll('.field-err').forEach(function (e) { e.classList.remove('show'); });
    });
  });
  function activateTab(name) {
    const t = document.querySelector('.tab[data-tab="' + name + '"]');
    if (t) t.click();
  }

  /* ---------- portal API forms ---------- */
  // form key -> { endpoint, build(form) } : maps the design's three tabs to the
  // existing portal contract. The waitlist "como pretende usar" note rides in the
  // lead's `name` field (the only free-text the backend records).
  const FORMS = {
    invite: {
      endpoint: '/portal/register',
      build: function () {
        return {
          invite_code: document.getElementById('invite').value,
          email: document.getElementById('reg-email').value
        };
      }
    },
    login: {
      endpoint: '/portal/login',
      build: function () {
        return { email: document.getElementById('login-email').value };
      }
    },
    waitlist: {
      endpoint: '/portal/request-invite',
      build: function () {
        return {
          email: document.getElementById('req-email').value,
          note: document.getElementById('req-note').value
        };
      }
    }
  };

  async function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
  }

  document.querySelectorAll('form[data-form]').forEach(function (form) {
    const key = form.getAttribute('data-form');
    const cfg = FORMS[key];
    if (!cfg) return;
    const err = form.querySelector('.field-err');
    const ok = document.querySelector('[data-ok="' + key + '"]');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (err) err.classList.remove('show');
      const btn = form.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;
      let res;
      try {
        res = await post(cfg.endpoint, cfg.build());
      } catch (_) {
        res = null;
      }
      if (btn) btn.disabled = false;
      if (res && res.ok) {
        form.style.display = 'none';
        if (ok) ok.classList.add('show');
      } else if (err) {
        err.classList.add('show');
      }
    });
  });

  /* ---------- emailed-invite prefill + expired-link notice ---------- */
  (function handleQuery() {
    const p = new URLSearchParams(location.search);
    const code = p.get('invite');
    const email = p.get('email');
    if (code) {
      const i = document.getElementById('invite');
      if (i) i.value = code;
    }
    if (email) {
      const e = document.getElementById('reg-email');
      if (e) e.value = email;
    }
    if (code || email) activateTab('invite');
    if (p.get('error') === 'link') {
      const note = document.getElementById('error');
      if (note) {
        note.textContent = 'Esse link expirou ou já foi usado. Peça um novo abaixo.';
        note.classList.add('show');
      }
    }
  })();

  /* ---------- reveal on scroll ---------- */
  // mark ready so opacity:0 base applies only with JS; reduced-motion users skip the hide
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) document.documentElement.classList.add('reveal-ready');
  const reveals = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
        if (en.target.id === 'chat') startChat();
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  reveals.forEach(function (el) { io.observe(el); });
  // safety net: if anything never reveals (IO quirks / paused tab), show it after 2.5s
  setTimeout(function () {
    reveals.forEach(function (el) { el.classList.add('in'); });
    startChat();
  }, 2500);

  /* ---------- chat demo: client switch + scenarios ---------- */
  let chatStarted = false;
  let currentClient = 'claude';
  let playToken = 0;
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M20 6 9 17l-5-5"/></svg>';
  const CLIENT_ICON = { claude: 'claude', code: 'claudecode', gpt: 'chatgpt' };

  // each scenario: question, tool calls, answer, plus optional cites or action cards
  const SCENARIOS = [
    {
      q: 'O que ficou decidido sobre o lançamento na reunião de quinta?',
      tools: [{ name: 'brain_search', arg: '"decisões lançamento"', badge: '3 fontes' }],
      answer: 'Na <strong>reunião de quinta (04/06)</strong>, o lançamento ficou para <strong>18/06</strong>. ' +
        'A landing entra primeiro e os convites saem em lotes de 50. A Ana fechou o texto; falta revisar o preço.',
      cites: [
        { ic: 'granola', t: 'Sync de Produto — 04/06', m: 'Granola' },
        { ic: 'notion', t: 'Plano de Lançamento', m: 'Notion' },
        { ic: 'calendar', t: 'Lançamento Zinom', m: '18/06' }
      ],
      dev: {
        q: 'por que escolhemos pgvector em vez de Pinecone?',
        tools: [{ name: 'brain_search', arg: '"pgvector vs Pinecone"', badge: '3 fontes', res: '3 resultados · workspace: eng' }],
        answer: 'Pela <strong>ADR-014</strong> (02/05) e pelo sync de infra (28/04): o time ficou com o ' +
          '<strong>pgvector</strong> pra manter tudo no mesmo Postgres — sem serviço externo, custo previsível e ' +
          'dados no seu servidor. O Pinecone caiu pelo lock-in.',
        cites: [
          { ic: 'notion', t: 'ADR-014 · Vector store', m: 'Notion' },
          { ic: 'granola', t: 'Sync de Infra — 28/04', m: 'Granola' }
        ]
      }
    },
    {
      q: 'Cria uma tarefa pra revisar o contrato e agenda sexta de manhã.',
      tools: [
        { name: 'notion_create_page', arg: '"Revisar contrato"', badge: 'tarefa' },
        { name: 'calendar_create_event', arg: '"sex 09:00"', badge: 'evento' }
      ],
      answer: 'Feito! Criei a tarefa no Notion e já reservei o horário na sua agenda — sem conflitos com outras reuniões.',
      actions: [
        { ic: 'notion', t: 'Revisar contrato', m: 'Tarefa no Notion · vence sex 06/06' },
        { ic: 'calendar', t: 'Revisar contrato', m: 'Sexta · 09:00 – 10:00' }
      ],
      dev: {
        q: 'cria a tarefa de refatorar o módulo de auth e agenda a revisão sexta 10h',
        tools: [
          { name: 'notion_create_page', arg: '"Refatorar auth", board: "Eng"', badge: 'tarefa', res: 'criada' },
          { name: 'calendar_create_event', arg: '"sex 10:00", 30min', badge: 'evento', res: 'agendado' }
        ],
        answer: 'Feito. Abri a tarefa no board de Eng e marquei a revisão na sua agenda.',
        actions: [
          { ic: 'notion', t: 'Refatorar módulo de auth', m: 'board Eng · prioridade alta' },
          { ic: 'calendar', t: 'Revisão: auth', m: 'Sexta · 10:00 – 10:30' }
        ]
      }
    },
    {
      q: 'Quais conversas tive com a Marina?',
      tools: [{ name: 'brain_search', arg: 'pessoa: "Marina"', badge: '5 fontes' }],
      answer: 'Você falou com a <strong>Marina</strong> em 3 conversas no último mês. Em resumo: ela vai liderar o ' +
        'onboarding, pediu os mockups até <strong>dia 10</strong> e ficou de enviar o orçamento. A última foi ontem.',
      cites: [
        { ic: 'granola', t: '1:1 com Marina — 05/06', m: 'Granola' },
        { ic: 'granola', t: 'Kickoff Onboarding — 28/05', m: 'Granola' },
        { ic: 'notion', t: 'Notas · Marina', m: 'Notion' }
      ],
      dev: {
        q: 'o que o Pedro decidiu sobre o rollout do novo deploy?',
        tools: [{ name: 'brain_search', arg: 'pessoa: "Pedro" deploy', badge: '4 fontes', res: '4 resultados · workspace: eng' }],
        answer: 'Em 2 conversas com o <strong>Pedro</strong>: rollout gradual (<strong>10% → 50% → 100%</strong>), ' +
          'feature flag obrigatória e rollback automático se erro &gt; 1%. Ele fica de revisar o pipeline até quarta.',
        cites: [
          { ic: 'granola', t: '1:1 com Pedro — 03/06', m: 'Granola' },
          { ic: 'notion', t: 'Runbook de Deploy', m: 'Notion' }
        ]
      }
    }
  ];

  function currentScenarioIndex() {
    const a = document.querySelector('.cp.active');
    return a ? parseInt(a.getAttribute('data-sc'), 10) || 0 : 0;
  }

  // pick base or dev variant depending on the active client
  function pickScenario(i) {
    const base = SCENARIOS[i] || SCENARIOS[0];
    return (currentClient === 'code' && base.dev) ? base.dev : base;
  }

  const TERM_TAG = {
    notion: ['notion', 'notion'], granola: ['granola', 'granola'], calendar: ['calendar', 'calendar']
  };
  function termTag(ic) {
    const x = TERM_TAG[ic] || ['ref', 'ref'];
    return '<span class="tag ' + x[0] + '">' + x[1] + '</span>';
  }

  async function playScenario(i) {
    const body = document.getElementById('chat-body');
    if (!body) return;
    const token = ++playToken;
    const sc = pickScenario(i);
    if (currentClient === 'code') { return renderTerminal(sc, token, body); }

    // ----- chat bubbles (Claude.ai / ChatGPT) -----
    body.className = 'chat-body';
    const aiIcon = ICONS[CLIENT_ICON[currentClient]] || ICONS.claude;
    body.innerHTML = '';

    await sleep(250); if (token !== playToken) return;
    body.appendChild(el('<div class="msg user"><div class="bubble">' + sc.q + '</div></div>'));

    await sleep(620); if (token !== playToken) return;
    const wrap = el('<div class="msg ai"><div class="av">' + aiIcon + '</div><div class="stack"></div></div>');
    body.appendChild(wrap);
    const inner = wrap.querySelector('.stack');

    // tool calls (Zinom is the tool — mark prefixes each chip)
    for (let k = 0; k < sc.tools.length; k++) {
      const tl = sc.tools[k];
      const tc = el(
        '<div class="tool-call"><span class="tmk">' + ICONS.zinom + '</span>' +
        '<span class="tk">' + tl.name + '</span>' +
        '<span class="arg">' + tl.arg + '</span>' +
        '<span class="score">' + tl.badge + '</span></div>'
      );
      tc.style.opacity = '0';
      inner.appendChild(tc);
      await sleep(60); if (token !== playToken) return;
      tc.style.transition = 'opacity .3s'; tc.style.opacity = '1';
      await sleep(440); if (token !== playToken) return;
    }

    // typing
    const typing = el('<div class="bubble ai"><span class="typing"><i></i><i></i><i></i></span></div>');
    inner.appendChild(typing);
    await sleep(1150); if (token !== playToken) { typing.remove(); return; }
    typing.remove();

    // answer (+ cites or action cards)
    let extra = '';
    if (sc.cites) {
      extra = '<div class="cites">' + sc.cites.map(function (c) {
        return '<a class="cite"><span class="ci">' + ICONS[c.ic] + '</span>' +
          '<span class="ttl">' + c.t + '</span><span class="meta">' + c.m + '</span></a>';
      }).join('') + '</div>';
    }
    if (sc.actions) {
      extra = '<div class="actions">' + sc.actions.map(function (a) {
        return '<div class="action"><span class="ck">' + CHECK + '</span>' +
          '<span class="ai-ic">' + ICONS[a.ic] + '</span>' +
          '<span class="col"><span class="tt">' + a.t + '</span><span class="mt">' + a.m + '</span></span></div>';
      }).join('') + '</div>';
    }
    const answer = el('<div class="bubble ai">' + sc.answer + extra + '</div>');
    answer.style.opacity = '0';
    inner.appendChild(answer);
    await sleep(40); if (token !== playToken) return;
    answer.style.transition = 'opacity .35s'; answer.style.opacity = '1';
  }

  // ----- terminal renderer (Claude Code CLI) -----
  async function renderTerminal(sc, token, body) {
    body.className = 'chat-body term';
    body.innerHTML = '';
    const add = function (html, cls) {
      const d = el('<div class="tl' + (cls ? ' ' + cls : '') + '">' + html + '</div>');
      body.appendChild(d);
      return d;
    };

    add('<span class="dim">~/projeto-api</span> <span class="pr">❯</span> <span class="cmd">claude</span>');
    await sleep(320); if (token !== playToken) return;
    add('<span class="pr">❯</span> <span class="q">' + sc.q + '</span>');
    await sleep(520); if (token !== playToken) return;

    for (let k = 0; k < sc.tools.length; k++) {
      const tl = sc.tools[k];
      add('<span class="bullet">●</span> <span class="dim">zinom</span> · <span class="fn">' + tl.name +
        '</span>(<span class="str">' + tl.arg + '</span>)', 'tool');
      const sub = add('<span class="sub">└ <span class="dim">executando…</span></span>');
      await sleep(560); if (token !== playToken) return;
      sub.innerHTML = '<span class="sub">└ <span class="ck">✓</span> ' + (tl.res || tl.badge) + '</span>';
      await sleep(220); if (token !== playToken) return;
    }

    const think = add('<span class="cursor"></span>');
    await sleep(950); if (token !== playToken) { think.remove(); return; }
    think.remove();

    if (sc.actions) {
      for (const a of sc.actions) {
        add('<span class="ck">✓</span> ' + termTag(a.ic) + '<span class="q">' + a.t +
          '</span> <span class="dim">— ' + a.m + '</span>', 'done');
      }
    } else {
      add(sc.answer, 'ans');
      if (sc.cites) {
        add('<span class="dim">fontes:</span>', 'ftitle');
        for (const c of sc.cites) {
          add(termTag(c.ic) + c.t + ' <span class="dim">· ' + c.m + '</span>', 'ref');
        }
      }
    }
  }

  function startChat() {
    if (chatStarted) return;
    chatStarted = true;
    playScenario(currentScenarioIndex());
  }

  // scenario chips
  document.querySelectorAll('.cp').forEach(function (cp) {
    cp.addEventListener('click', function () {
      document.querySelectorAll('.cp').forEach(function (x) { x.classList.toggle('active', x === cp); });
      chatStarted = true;
      playScenario(parseInt(cp.getAttribute('data-sc'), 10) || 0);
    });
  });

  // client switch
  document.querySelectorAll('.cl').forEach(function (cl) {
    cl.addEventListener('click', function () {
      document.querySelectorAll('.cl').forEach(function (x) { x.classList.toggle('active', x === cl); });
      currentClient = cl.getAttribute('data-cl');
      chatStarted = true;
      playScenario(currentScenarioIndex());
    });
  });
})();
