/* landing.js — ícones, nav, reveal on scroll, card de acesso + API do portal, diagrama.
   Os formulários chamam os endpoints reais (/portal/register,
   /portal/request-invite) com credentials pra sessão round-trip. */
(function () {
  'use strict';

  var API = window.PORTAL_API_BASE || '';

  /* ---------- ícones inline ---------- */
  var Z_GREEN = 'var(--accent)';
  var ICONS = {
    zinom:
      '<svg viewBox="0 0 26 26" fill="none">' +
      '<rect x="1" y="1" width="24" height="24" rx="7.5" fill="' + Z_GREEN + '"/>' +
      '<path d="M8 8 H18 L8 18 H18" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="8" cy="8" r="1.7" fill="#fff"/><circle cx="18" cy="8" r="1.7" fill="#fff"/>' +
      '<circle cx="8" cy="18" r="1.7" fill="#fff"/><circle cx="18" cy="18" r="1.7" fill="#fff"/></svg>',
    notion:
      '<svg viewBox="0 0 24 24" fill="none">' +
      '<rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="#fff" stroke="#26241f" stroke-width="1.6"/>' +
      '<path d="M8 16.5v-9l8 9v-9" stroke="#26241f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    granola:
      '<svg viewBox="0 0 24 24" fill="none">' +
      '<rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="#f6c544"/>' +
      '<path d="M15.5 9.2a4.4 4.4 0 1 0 1 3.3h-3.6" stroke="#26241f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    calendar:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#3d6fae" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3.5" y="5" width="17" height="16" rx="3" fill="#ecf3fc"/>' +
      '<path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="12" cy="15.5" r="1.4" fill="#3d6fae" stroke="none"/></svg>',
    claude:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#d97757" stroke-width="2.1" stroke-linecap="round">' +
      '<path d="M12 4v16M5.1 8l13.8 8M18.9 8 5.1 16"/></svg>',
    claudecode:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#26241f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2.5" y="4" width="19" height="16" rx="3"/>' +
      '<path d="M7 10l3 2.5L7 15M12.5 15.5H17"/></svg>',
    chatgpt:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#26241f" stroke-width="1.8">' +
      '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/></svg>',
    cursor:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#26241f" stroke-width="1.8" stroke-linejoin="round">' +
      '<path d="M6 4l13 7.5-5.6 1.6L11 19z"/></svg>',
    mcp:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#26241f" stroke-width="1.8" stroke-linecap="round">' +
      '<path d="M8 4v5a4 4 0 0 0 8 0V4M12 13v7M9 20h6"/></svg>',
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 6 9 17l-5-5"/></svg>',
    doc:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    zap:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
      '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>'
  };

  function injectIcons(root) {
    (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
      var name = el.getAttribute('data-ic');
      if (ICONS[name] && !el.firstChild) el.innerHTML = ICONS[name];
    });
  }
  window.lv2Icons = { inject: injectIcons, ICONS: ICONS };

  /* Watcher de visibilidade robusto: tenta IntersectionObserver, mas também
     verifica getBoundingClientRect via scroll/resize/interval (alguns contextos
     nunca disparam callbacks de IO). Dispara cb(el) uma única vez por elemento. */
  function watchVisible(el, cb, margin) {
    var fired = false;
    var off = margin == null ? 80 : margin;
    function fire() {
      if (fired) return;
      fired = true;
      cleanup();
      cb(el);
    }
    function check() {
      if (fired) return;
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.top < vh - off && r.bottom > 0) fire();
    }
    var io = null, iv = null;
    if ('IntersectionObserver' in window) {
      try {
        io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) fire(); });
        }, { threshold: 0.1, rootMargin: '0px 0px -' + off + 'px 0px' });
        io.observe(el);
      } catch (e) { io = null; }
    }
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    iv = setInterval(check, 450);
    function cleanup() {
      if (io) io.disconnect();
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      clearInterval(iv);
    }
    check();
  }
  window.lv2Visible = { watch: watchVisible };

  /* ---------- formulários → API do portal ---------- */
  var FORMS = {
    invite: {
      endpoint: '/portal/register',
      build: function () {
        return {
          invite_code: document.getElementById('invite').value,
          email: document.getElementById('reg-email').value
        };
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

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
  }

  function activatePane(name) {
    document.querySelectorAll('.tabs .tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.pane').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === name);
    });
    document.querySelectorAll('.field-err').forEach(function (e) { e.classList.remove('show'); });
  }

  function init() {
    injectIcons(document);

    // nav shadow
    var nav = document.getElementById('nav');
    function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // reveal (reduced motion pula a fase escondida)
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) document.documentElement.classList.add('reveal-ready');
    document.querySelectorAll('.reveal').forEach(function (el) {
      watchVisible(el, function () { el.classList.add('in'); }, 40);
    });

    // tabs do card de acesso
    document.querySelectorAll('.tabs .tab').forEach(function (t) {
      t.addEventListener('click', function () { activatePane(t.getAttribute('data-tab')); });
    });

    // formulários
    document.querySelectorAll('form[data-form]').forEach(function (form) {
      var key = form.getAttribute('data-form');
      var cfg = FORMS[key];
      if (!cfg) return;
      var err = form.querySelector('.field-err');
      var ok = document.querySelector('[data-ok="' + key + '"]');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (err) err.classList.remove('show');
        var btn = form.querySelector('button[type=submit]');
        if (btn) btn.disabled = true;
        post(cfg.endpoint, cfg.build())
          .catch(function () { return null; })
          .then(function (res) {
            if (btn) btn.disabled = false;
            if (res && res.ok) {
              form.style.display = 'none';
              if (ok) ok.classList.add('show');
            } else if (err) {
              err.classList.add('show');
            }
          });
      });
    });

    // prefill do convite por e-mail + aviso de link expirado
    (function handleQuery() {
      var p = new URLSearchParams(location.search);
      var code = p.get('invite');
      var email = p.get('email');
      if (code) {
        var i = document.getElementById('invite');
        if (i) i.value = code;
      }
      if (email) {
        var e = document.getElementById('reg-email');
        if (e) e.value = email;
      }
      if (code || email) activatePane('invite');
      if (p.get('error') === 'link') {
        var note = document.getElementById('error');
        if (note) {
          note.textContent = 'Esse link expirou ou já foi usado. Peça um novo abaixo.';
          note.classList.add('show');
        }
      }
    })();

    // diagrama: acende nós em sequência
    var nodes = document.querySelectorAll('#diagram .dg-node');
    if (nodes.length) {
      var i = 0;
      setInterval(function () {
        nodes.forEach(function (n) { n.classList.remove('lit'); });
        nodes[i % nodes.length].classList.add('lit');
        i++;
      }, 1400);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
