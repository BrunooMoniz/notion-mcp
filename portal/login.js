/* login.js — extraído do inline (CSP script-src 'self' bloqueia script inline) */
'use strict';
(function () {
  var form = document.getElementById('login-form');
  var btn = document.getElementById('login-btn');
  var errEl = document.getElementById('login-err');
  var okEl = document.getElementById('login-ok');

  function showErr(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }
  function hideErr() { errEl.style.display = 'none'; }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideErr();
    var email = (document.getElementById('login-email').value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showErr('E-mail inválido. Confira e tente de novo.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      var res = await fetch('/portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
        credentials: 'include',
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        showErr(data.error || 'Erro ao enviar o link. Tente de novo.');
        btn.disabled = false;
        btn.textContent = 'Enviar link de acesso';
        return;
      }
      // Always show success (generic response — doesn't reveal whether email exists)
      form.style.display = 'none';
      okEl.style.display = 'block';
    } catch (err) {
      showErr('Sem conexão. Verifique a internet e tente de novo.');
      btn.disabled = false;
      btn.textContent = 'Enviar link de acesso';
    }
  });
})();
