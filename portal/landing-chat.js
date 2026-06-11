/* landing-chat.js — demo de chat com cenários roteirizados.
   Sincroniza com os passos numerados (.dstep[data-step]) na coluna esquerda. */
(function () {
  'use strict';

  var SCENARIOS = [
    {
      label: 'Buscar uma decisão',
      steps: [
        { type: 'user', step: 1, text: 'O que ficou decidido sobre preços na reunião com a Ana?' },
        { type: 'tool', step: 2, fn: 'brain_search', arg: '"decisão preços Ana"', delay: 1400 },
        {
          type: 'answer', step: 3,
          html: 'Na 1:1 de hoje vocês decidiram <strong>manter o Pro a R$ 9,99</strong> e testar um plano anual com desconto. A Ana ficou de validar a margem com o financeiro <strong>até sexta</strong>.',
          cites: [
            { ic: 'granola', ttl: '1:1 com a Ana', meta: 'reunião · hoje' },
            { ic: 'notion', ttl: 'Decisões · Projeto Atlas', meta: 'Notion · hoje' }
          ]
        }
      ]
    },
    {
      label: 'Criar tarefa + agendar',
      steps: [
        { type: 'user', step: 1, text: 'Cria uma tarefa pra eu revisar a proposta e bloqueia 1h na minha agenda amanhã às 14h.' },
        { type: 'tool', step: 4, fn: 'notion_create_page', arg: 'database: "Tarefas"', delay: 1300 },
        { type: 'tool', step: 4, fn: 'create_calendar_event', arg: 'qui 14:00–15:00', delay: 1300 },
        {
          type: 'answer', step: 4,
          html: 'Feito. Tarefa criada e horário bloqueado:',
          actions: [
            { ic: 'notion', tt: 'Revisar proposta comercial', mt: 'Tarefas · prazo: sexta' },
            { ic: 'calendar', tt: 'Revisão da proposta', mt: 'quinta · 14:00–15:00' }
          ]
        }
      ]
    },
    {
      label: 'Briefing do dia',
      steps: [
        { type: 'user', step: 1, text: 'Me prepara pro meu dia.' },
        { type: 'tool', step: 2, fn: 'list_events', arg: 'hoje', delay: 1100 },
        { type: 'tool', step: 2, fn: 'brain_search', arg: '"pendências desta semana"', delay: 1300 },
        {
          type: 'answer', step: 3,
          html: 'Você tem <strong>3 compromissos</strong>: review de sprint às 10h, almoço com investidor às 12h30 e 1:1 com a Ana às 16h. Antes do almoço, vale revisar a <strong>proposta comercial</strong>: o investidor citou preços na última conversa.',
          cites: [
            { ic: 'calendar', ttl: 'Agenda de hoje', meta: '3 eventos' },
            { ic: 'granola', ttl: 'Call com investidor', meta: 'reunião · semana passada' }
          ]
        }
      ]
    }
  ];

  var CLIENTS = {
    claude: { ic: 'claude', name: 'Claude.ai' },
    code: { ic: 'claudecode', name: 'Claude Code' },
    gpt: { ic: 'chatgpt', name: 'ChatGPT' }
  };

  var body, timers = [], currentSc = 0, currentCl = 'claude';

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); return ms; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function setStep(n) {
    document.querySelectorAll('.dstep').forEach(function (d) {
      d.classList.toggle('on', +d.getAttribute('data-step') === n);
    });
  }

  function scrollBottom() { body.scrollTop = body.scrollHeight; }

  function addUser(text, done) {
    var m = el('div', 'msg user');
    var b = el('span', 'bubble', '');
    m.appendChild(b);
    body.appendChild(m);
    var i = 0;
    var iv = setInterval(function () {
      b.textContent = text.slice(0, ++i);
      scrollBottom();
      if (i >= text.length) { clearInterval(iv); later(done, 500); }
    }, 26);
    timers.push(iv);
  }

  function aiStack() {
    var last = body.lastElementChild;
    if (last && last.classList.contains('msg') && last.classList.contains('ai')) {
      return last.querySelector('.stack');
    }
    var m = el('div', 'msg ai');
    m.innerHTML = '<span class="av"><span class="ic" data-ic="' + CLIENTS[currentCl].ic + '"></span></span><span class="stack"></span>';
    body.appendChild(m);
    window.lv2Icons.inject(m);
    return m.querySelector('.stack');
  }

  function addTool(fn, arg, delay, done) {
    var stack = aiStack();
    var t = el('div', 'tool-call',
      '<span class="tmk" data-ic="zinom"></span><span class="tk">' + fn + '</span>' +
      '<span class="arg">' + arg + '</span><span class="spin"></span>');
    stack.appendChild(t);
    window.lv2Icons.inject(t);
    scrollBottom();
    later(function () {
      var sp = t.querySelector('.spin');
      sp.outerHTML = '<span class="okk">✓</span>';
      later(done, 350);
    }, delay);
  }

  function addAnswer(s, done) {
    var stack = aiStack();
    var typing = el('div', 'typing', '<i></i><i></i><i></i>');
    stack.appendChild(typing);
    scrollBottom();
    later(function () {
      typing.remove();
      var b = el('div', 'bubble ai', s.html);
      if (s.cites) {
        var c = el('div', 'cites', '<span class="lbl">Fontes</span>');
        s.cites.forEach(function (ct) {
          c.appendChild(el('a', 'cite',
            '<span class="ic" data-ic="' + ct.ic + '"></span><span class="ttl">' + ct.ttl + '</span>' +
            '<span class="meta">' + ct.meta + '</span>'));
        });
        b.appendChild(c);
      }
      stack.appendChild(b);
      if (s.actions) {
        var ac = el('div', 'actions', '');
        s.actions.forEach(function (a, i) {
          var row = el('div', 'action',
            '<span class="ck"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
            '<span class="ic" data-ic="' + a.ic + '"></span>' +
            '<span class="col"><span class="tt">' + a.tt + '</span><span class="mt">' + a.mt + '</span></span>');
          row.style.opacity = '0';
          row.style.transition = 'opacity .35s ease';
          ac.appendChild(row);
          later(function () { row.style.opacity = '1'; scrollBottom(); }, 900 + i * 450);
        });
        stack.appendChild(ac);
      }
      window.lv2Icons.inject(stack);
      scrollBottom();
      later(done, 600);
    }, 1100);
  }

  function showReplay() {
    var r = el('div', 'chat-replay',
      '<button type="button"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg> Ver de novo</button>');
    r.querySelector('button').addEventListener('click', function () { play(currentSc); });
    body.appendChild(r);
    scrollBottom();
  }

  function play(scIdx) {
    clearTimers();
    currentSc = scIdx;
    body.innerHTML = '';
    setStep(0);
    document.querySelectorAll('#chat-prompts .cp').forEach(function (c, i) {
      c.classList.toggle('active', i === scIdx);
    });

    var steps = SCENARIOS[scIdx].steps;
    var k = 0;
    function next() {
      if (k >= steps.length) {
        later(function () { setStep(0); showReplay(); }, 800);
        return;
      }
      var s = steps[k++];
      setStep(s.step);
      if (s.type === 'user') later(function () { addUser(s.text, next); }, 350);
      else if (s.type === 'tool') addTool(s.fn, s.arg, s.delay, next);
      else addAnswer(s, next);
    }
    next();
  }

  function setClient(cl) {
    currentCl = cl;
    document.querySelectorAll('#clients .cl').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-cl') === cl);
    });
    play(currentSc);
  }

  function init() {
    body = document.getElementById('chat-body');
    document.querySelectorAll('#chat-prompts .cp').forEach(function (c, i) {
      c.addEventListener('click', function () { play(i); });
    });
    document.querySelectorAll('#clients .cl').forEach(function (b) {
      b.addEventListener('click', function () { setClient(b.getAttribute('data-cl')); });
    });

    var chat = document.getElementById('chat');
    var started = false;
    function start() {
      if (started) return;
      started = true;
      play(0);
    }
    if (window.lv2Visible) window.lv2Visible.watch(chat, start, 120);
    else start();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
