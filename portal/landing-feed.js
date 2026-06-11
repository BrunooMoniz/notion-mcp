/* landing-feed.js — demo "alimente seu cérebro no dia a dia"
   Timeline auto-play: eventos do dia entram à esquerda, memórias
   aparecem no cérebro à direita, e no fim uma busca mostra o payoff. */
(function () {
  'use strict';

  var STEPS = [
    {
      time: '09:00',
      source: 'granola',
      stepLabel: 'Reunião',
      card: {
        title: '1:1 com a Ana',
        meta: 'Você só participa da reunião. O Granola grava e resume a conversa sozinho.',
        src: 'GRANOLA · transcript automático'
      },
      mem: { tag: 'granola', title: 'Reunião · 1:1 com a Ana', chunks: '+18 trechos' },
      dur: 5200
    },
    {
      time: '10:42',
      source: 'notion',
      stepLabel: 'Notion',
      card: {
        title: 'Decisões · Projeto Atlas',
        meta: 'Você escreve no Notion como sempre escreveu. Nenhum passo extra.',
        src: 'NOTION · página atualizada'
      },
      mem: { tag: 'notion', title: 'Página · Decisões · Projeto Atlas', chunks: '+9 trechos' },
      dur: 5200
    },
    {
      time: '12:10',
      source: 'calendar',
      stepLabel: 'Agenda',
      card: {
        title: 'Almoço com investidor · sex 12:30',
        meta: 'Um convite chega na sua agenda. O Zinom sincroniza via iCal.',
        src: 'GOOGLE CALENDAR · evento novo'
      },
      mem: { tag: 'calendar', title: 'Evento · Almoço com investidor', chunks: '+1 evento' },
      dur: 5200
    },
    {
      time: '15:30',
      source: 'granola',
      stepLabel: 'Reunião',
      card: {
        title: 'Review de sprint',
        meta: 'Mais uma reunião do dia, capturada e resumida automaticamente.',
        src: 'GRANOLA · transcript automático'
      },
      mem: { tag: 'granola', title: 'Reunião · Review de sprint', chunks: '+24 trechos' },
      dur: 5200
    },
    {
      time: '23:00',
      source: 'zinom',
      stepLabel: 'Pergunte',
      payoff: true,
      dur: 9000
    }
  ];

  var TAG_CLASS = { granola: 't-granola', notion: 't-notion', calendar: 't-calendar' };
  var TAG_LABEL = { granola: 'GRANOLA', notion: 'NOTION', calendar: 'AGENDA' };
  var QUERY = '"o que ficou decidido com a Ana?"';
  var ANSWER = 'Vocês decidiram <b>manter o Pro a R$ 9,99</b> e testar um plano anual com desconto. ' +
    'A Ana valida com o financeiro até sexta, <b>antes do seu almoço com o investidor</b>.';

  var els = {};
  var state = { idx: -1, playing: true, timer: null, typeTimer: null, chunkTimer: null, chunks: 0, started: false };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function buildSteps() {
    STEPS.forEach(function (s, i) {
      var b = el('button', 'fl-step');
      b.type = 'button';
      var icName = s.source === 'zinom' ? 'zinom' : s.source;
      b.innerHTML = '<span class="ic" data-ic="' + icName + '"></span>' +
        '<span class="tm">' + s.time + '</span> ' + s.stepLabel + '<span class="bar"></span>';
      b.addEventListener('click', function () { goTo(i, true); });
      els.steps.appendChild(b);
    });
    window.lv2Icons.inject(els.steps);
  }

  function setClock(t) { els.clock.textContent = t; }

  function tickChunks(target) {
    clearInterval(state.chunkTimer);
    state.chunkTimer = setInterval(function () {
      if (state.chunks >= target) { clearInterval(state.chunkTimer); state.chunks = target; }
      else state.chunks += Math.max(1, Math.ceil((target - state.chunks) / 6));
      els.count.textContent = state.chunks;
    }, 70);
  }

  function chunkTargetUpTo(idx) {
    var n = 0;
    STEPS.slice(0, idx + 1).forEach(function (s) {
      if (s.mem) n += parseInt(s.mem.chunks.replace(/\D/g, ''), 10);
    });
    return n;
  }

  function addDayCard(s) {
    var c = el('div', 'fl-card');
    c.innerHTML =
      '<span class="badge-ic ' + s.source + '"><span class="ic" data-ic="' + s.source + '"></span></span>' +
      '<span class="col">' +
      '<span class="tt">' + s.card.title + '</span>' +
      '<span class="mt">' + s.card.meta + '</span>' +
      '<span class="src"><span class="tag ' + TAG_CLASS[s.source] + '">' + TAG_LABEL[s.source] + '</span>' +
      s.card.src.split('·')[1].trim() + '</span></span>';
    els.day.appendChild(c);
    window.lv2Icons.inject(c);
    requestAnimationFrame(function () { requestAnimationFrame(function () { c.classList.add('in'); }); });
    return c;
  }

  function addMemory(s) {
    var m = el('div', 'fl-mem');
    m.innerHTML =
      '<span class="tag ' + TAG_CLASS[s.source] + '">' + TAG_LABEL[s.source] + '</span>' +
      '<span class="tt">' + s.mem.title + '</span>' +
      '<span class="chunks">' + s.mem.chunks + '</span>' +
      '<span class="score"></span>';
    els.memList.appendChild(m);
    requestAnimationFrame(function () { requestAnimationFrame(function () { m.classList.add('in'); }); });
    return m;
  }

  function firePulse() {
    var d = el('i', 'fl-dot');
    els.lane.appendChild(d);
    requestAnimationFrame(function () { d.classList.add('go'); });
    setTimeout(function () { d.remove(); }, 1100);
  }

  function clearStage() {
    clearTimeout(state.timer);
    clearInterval(state.typeTimer);
    clearInterval(state.chunkTimer);
    els.day.innerHTML = '';
    els.memList.innerHTML = '';
    els.search.classList.remove('show');
    els.answer.classList.remove('show');
    els.queryText.textContent = '';
    state.chunks = 0;
    els.count.textContent = '0';
    var empty = el('div', 'fl-empty', 'Seu dia começa como qualquer outro.<br>Você não instala nada, não copia nada, não cola nada.');
    empty.id = 'fl-empty';
    els.day.appendChild(empty);
  }

  function markStepChips(idx) {
    var chips = els.steps.querySelectorAll('.fl-step');
    chips.forEach(function (c, i) {
      c.classList.toggle('active', i === idx);
      c.classList.toggle('done', i < idx);
      if (i === idx) c.style.setProperty('--fl-dur', (STEPS[idx].dur / 1000) + 's');
    });
  }

  function dimOldCards() {
    var cards = els.day.querySelectorAll('.fl-card');
    cards.forEach(function (c, i) {
      c.classList.remove('lit');
      c.classList.toggle('dim', i < cards.length - 1);
    });
  }

  function runPayoff() {
    // destaca as memórias relevantes como resultados de busca
    els.search.classList.add('show');
    var q = QUERY;
    var i = 0;
    clearInterval(state.typeTimer);
    state.typeTimer = setInterval(function () {
      els.queryText.textContent = q.slice(0, ++i);
      if (i >= q.length) {
        clearInterval(state.typeTimer);
        setTimeout(function () {
          var mems = els.memList.querySelectorAll('.fl-mem');
          var hits = [
            { el: mems[0], score: '0.94' },   // 1:1 com a Ana
            { el: mems[1], score: '0.87' },   // Decisões Atlas
            { el: mems[2], score: '0.71' }    // Almoço investidor
          ];
          hits.forEach(function (h, k) {
            if (!h.el) return;
            setTimeout(function () {
              h.el.classList.add('hit', 'scored');
              h.el.querySelector('.score').textContent = h.score;
            }, 350 * k);
          });
          setTimeout(function () { els.answer.classList.add('show'); }, 350 * hits.length + 400);
        }, 350);
      }
    }, 38);
  }

  function goTo(idx, manual) {
    if (manual) { state.playing = true; }
    clearTimeout(state.timer);
    clearInterval(state.typeTimer);

    // reconstrução determinística até idx
    clearStage();
    var emptyEl = $('fl-empty');
    for (var i = 0; i < idx; i++) {
      var s = STEPS[i];
      if (!s.mem) continue;
      if (emptyEl) { emptyEl.remove(); emptyEl = null; }
      addDayCard(s).classList.add('dim');
      addMemory(s);
    }
    state.chunks = chunkTargetUpTo(idx - 1);
    els.count.textContent = state.chunks;

    state.idx = idx;
    var step = STEPS[idx];
    markStepChips(idx);
    setClock(step.time);

    if (step.payoff) {
      els.dayHead.textContent = 'Fim do dia: nada mudou na sua rotina';
      runPayoff();
    } else {
      els.dayHead.textContent = 'Seu dia, como sempre';
      if (emptyEl) emptyEl.remove();
      var card = addDayCard(step);
      card.classList.add('lit');
      dimOldCards();
      card.classList.add('lit');
      setTimeout(firePulse, 700);
      setTimeout(function () {
        addMemory(step);
        tickChunks(chunkTargetUpTo(idx));
      }, 1450);
    }

    if (state.playing) {
      state.timer = setTimeout(function () {
        goTo((idx + 1) % STEPS.length, false);
      }, step.dur);
    }
  }

  function togglePlay() {
    state.playing = !state.playing;
    els.playIc.innerHTML = state.playing ? PAUSE : PLAY;
    if (state.playing) goTo((state.idx + 1) % STEPS.length, false);
    else { clearTimeout(state.timer); markStepChips(-1); markStepChips(state.idx); }
  }

  var PLAY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
  var PAUSE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>';

  function init() {
    els.steps = $('fl-steps');
    els.day = $('fl-day-body');
    els.dayHead = $('fl-day-title');
    els.clock = $('fl-clock');
    els.memList = $('fl-mem-list');
    els.count = $('fl-count-n');
    els.lane = $('fl-lane');
    els.search = $('fl-search');
    els.queryText = $('fl-query-text');
    els.answer = $('fl-answer');
    els.answer.innerHTML = ANSWER;
    var playBtn = $('fl-play');
    els.playIc = playBtn;
    playBtn.innerHTML = PAUSE;
    playBtn.addEventListener('click', togglePlay);

    buildSteps();
    clearStage();
    markStepChips(0);
    setClock('08:00');

    // só começa quando a seção entra na viewport (watcher com fallback)
    var section = $('alimente');
    function start() {
      if (state.started) return;
      state.started = true;
      goTo(0, false);
    }
    if (window.lv2Visible) window.lv2Visible.watch(section, start, 160);
    else start();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
