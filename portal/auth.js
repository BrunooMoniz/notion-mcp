// portal/auth.js — front-page logic: register by invite, login by email.
// Calls the portal API with credentials so the session cookie round-trips.
const API = window.PORTAL_API_BASE || "";

function showError() {
  const p = new URLSearchParams(location.search);
  if (p.get("error") === "link") {
    const el = document.getElementById("error");
    el.textContent = "Esse link expirou ou já foi usado. Peça um novo abaixo.";
    el.classList.remove("hidden");
  }
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return res;
}

function onSent() {
  document.getElementById("forms").classList.add("hidden");
  document.getElementById("error").classList.add("hidden");
  document.getElementById("sent").classList.remove("hidden");
}

document.getElementById("show-login").addEventListener("click", () => {
  document.getElementById("login-form").classList.remove("hidden");
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await post("/portal/register", {
    invite_code: document.getElementById("invite").value,
    email: document.getElementById("reg-email").value,
  });
  if (res.ok) onSent();
  else {
    const el = document.getElementById("error");
    el.textContent = "E-mail inválido. Confira e tente de novo.";
    el.classList.remove("hidden");
  }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await post("/portal/login", {
    email: document.getElementById("login-email").value,
  });
  if (res.ok) onSent();
});

// Request access (lead) — feeds the admin leads list.
document.getElementById("request-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await post("/portal/request-invite", {
    email: document.getElementById("req-email").value,
    name: document.getElementById("req-name").value,
  });
  if (res.ok) {
    document.getElementById("request-form").classList.add("hidden");
    document.getElementById("req-sent").classList.remove("hidden");
  }
});

// Prefill the invite code + email from an emailed invite link (?invite=&email=).
function prefillFromInvite() {
  const p = new URLSearchParams(location.search);
  const code = p.get("invite");
  const email = p.get("email");
  if (code) document.getElementById("invite").value = code;
  if (email) document.getElementById("reg-email").value = email;
}

prefillFromInvite();
showError();
