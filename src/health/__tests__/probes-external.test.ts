// src/health/__tests__/probes-external.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { makeExternalProbes } from "../probes-external.js";

// ---------- helpers de teste ----------

/** Cria um Response fake com status e body JSON opcional. */
function fakeResponse(status: number, body?: unknown): Response {
  return new Response(body !== undefined ? JSON.stringify(body) : null, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Cria um fetch fake que retorna respostas distintas por URL (prefixo). */
function makeFetch(
  map: Record<string, Response | (() => Response)>,
  fallback?: Response,
): typeof fetch {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    for (const [key, val] of Object.entries(map)) {
      if (url.startsWith(key)) {
        return typeof val === "function" ? val() : val;
      }
    }
    if (fallback) return fallback;
    throw new Error(`fetch não esperado para: ${url}`);
  };
}

/** Cria um fetch que sempre lança (simula timeout/network error). */
function errorFetch(msg: string): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error(msg);
  };
}

// ---------- gerenciamento de envs ----------

const ENV_KEYS = [
  "NOTION_PERSONAL_TOKEN",
  "NOTION_GLOBALCRIPTO_TOKEN",
  "NOTION_NORA_TOKEN",
  "ANTHROPIC_API_KEY",
  "VOYAGE_API_KEY",
  "VOYAGE_EMBEDDINGS_URL",
  "RESEND_API_KEY",
  "STRIPE_SECRET_KEY",
  "HEALTH_PUBLIC_URL",
  "NTFY_URL",
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

// ---------- testes ----------

test("notion:personal → ok com latência quando 200", async () => {
  process.env.NOTION_PERSONAL_TOKEN = "ntn_personal_token";
  const f = makeFetch({ "https://api.notion.com": fakeResponse(200, { object: "user" }) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "notion:personal");
  assert.ok(r, "check notion:personal ausente");
  assert.strictEqual(r!.status, "ok");
  assert.ok(typeof r!.latencyMs === "number" && r!.latencyMs >= 0, "latência deve ser número >= 0");
  assert.strictEqual(r!.group, "parceiros");
  assert.strictEqual(r!.label, "Notion (personal)");
});

test("notion:personal → fail 'HTTP 500' em 500", async () => {
  process.env.NOTION_PERSONAL_TOKEN = "ntn_personal_token";
  const f = makeFetch({ "https://api.notion.com": fakeResponse(500) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "notion:personal");
  assert.strictEqual(r!.status, "fail");
  assert.strictEqual(r!.error, "HTTP 500");
});

test("notion:personal → skip quando env ausente", async () => {
  const f = errorFetch("não deveria ser chamado");
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "notion:personal");
  assert.strictEqual(r!.status, "skip");
});

test("notion: três workspaces em paralelo (personal ok, globalcripto fail, nora skip)", async () => {
  process.env.NOTION_PERSONAL_TOKEN = "ntn_personal";
  process.env.NOTION_GLOBALCRIPTO_TOKEN = "ntn_globalcripto";
  // nora ausente → skip

  let callCount = 0;
  const f: typeof fetch = async (input, init) => {
    callCount++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
    if (authHeader.includes("ntn_personal")) return fakeResponse(200, {});
    if (authHeader.includes("ntn_globalcripto")) return fakeResponse(403);
    throw new Error(`fetch inesperado para ${url}`);
  };

  const [probe] = makeExternalProbes(f);
  const results = await probe();

  assert.strictEqual(results.find((x) => x.checkId === "notion:personal")!.status, "ok");
  assert.strictEqual(results.find((x) => x.checkId === "notion:globalcripto")!.status, "fail");
  assert.strictEqual(results.find((x) => x.checkId === "notion:nora")!.status, "skip");
  assert.ok(callCount >= 2, "deve ter feito pelo menos 2 chamadas");
});

test("anthropic → ok 200", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const f = makeFetch({ "https://api.anthropic.com": fakeResponse(200, { data: [] }) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "anthropic");
  assert.strictEqual(r!.status, "ok");
  assert.strictEqual(r!.group, "parceiros");
  assert.strictEqual(r!.label, "Anthropic API");
});

test("anthropic → fail 401", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-invalid";
  const f = makeFetch({ "https://api.anthropic.com": fakeResponse(401) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "anthropic");
  assert.strictEqual(r!.status, "fail");
  assert.strictEqual(r!.error, "HTTP 401");
});

test("anthropic → skip sem env", async () => {
  const [probe] = makeExternalProbes(errorFetch("não deve chamar"));
  const results = await probe();
  assert.strictEqual(results.find((x) => x.checkId === "anthropic")!.status, "skip");
});

test("voyage → ok 200 (URL padrão)", async () => {
  process.env.VOYAGE_API_KEY = "pa-voyage-test";
  const f = makeFetch({ "https://api.voyageai.com": fakeResponse(200, { data: [] }) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "voyage");
  assert.strictEqual(r!.status, "ok");
  assert.strictEqual(r!.label, "Voyage AI");
});

test("voyage → usa VOYAGE_EMBEDDINGS_URL quando definida", async () => {
  process.env.VOYAGE_API_KEY = "pa-voyage-test";
  process.env.VOYAGE_EMBEDDINGS_URL = "https://egress.example.com/v1/embeddings";
  const voyageCalls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("https://egress.example.com")) voyageCalls.push(url);
    return fakeResponse(url.startsWith("https://egress.example.com") ? 200 : 401, {});
  };
  const [probe] = makeExternalProbes(f);
  await probe();
  assert.ok(voyageCalls.length >= 1, "Voyage não foi chamado com a URL override");
  assert.ok(voyageCalls[0].startsWith("https://egress.example.com"), `URL errada: ${voyageCalls[0]}`);
});

test("voyage → skip sem VOYAGE_API_KEY", async () => {
  const [probe] = makeExternalProbes(errorFetch("não deve chamar"));
  const results = await probe();
  assert.strictEqual(results.find((x) => x.checkId === "voyage")!.status, "skip");
});

test("voyage → fail 500", async () => {
  process.env.VOYAGE_API_KEY = "pa-voyage";
  const f = makeFetch({ "https://api.voyageai.com": fakeResponse(500) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  assert.strictEqual(results.find((x) => x.checkId === "voyage")!.error, "HTTP 500");
});

test("resend → ok 200", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const f = makeFetch({ "https://api.resend.com": fakeResponse(200, { data: [] }) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "resend");
  assert.strictEqual(r!.status, "ok");
  assert.strictEqual(r!.label, "Resend");
});

test("resend → 401 restricted_api_key é ok (chave de envio válida)", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const f = makeFetch({
    "https://api.resend.com": fakeResponse(401, {
      name: "restricted_api_key",
      message: "This API key is restricted to only send emails",
    }),
  }, fakeResponse(200, {}));
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "resend");
  assert.strictEqual(r!.status, "ok");
  assert.deepStrictEqual(r!.detail, { restricted: true });
  assert.strictEqual(r!.error, undefined);
});

test("resend → 401 com outro name continua fail", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const f = makeFetch({
    "https://api.resend.com": fakeResponse(401, { name: "invalid_api_key" }),
  }, fakeResponse(200, {}));
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "resend");
  assert.strictEqual(r!.status, "fail");
  assert.strictEqual(r!.error, "HTTP 401");
});

test("resend → skip sem env", async () => {
  const [probe] = makeExternalProbes(errorFetch("não deve chamar"));
  assert.strictEqual((await probe()).find((x) => x.checkId === "resend")!.status, "skip");
});

test("stripe → ok 200 com detail {available, pending}", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_stripe";
  const body = {
    available: [
      { amount: 1000, currency: "usd" },
      { amount: 500, currency: "brl" },
    ],
    pending: [{ amount: 200, currency: "usd" }],
  };
  const f = makeFetch({ "https://api.stripe.com": fakeResponse(200, body) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "stripe");
  assert.strictEqual(r!.status, "ok");
  assert.strictEqual(r!.label, "Stripe");
  assert.deepStrictEqual(r!.detail?.available, body.available);
  assert.deepStrictEqual(r!.detail?.pending, body.pending);
});

test("stripe → skip sem env", async () => {
  const [probe] = makeExternalProbes(errorFetch("não deve chamar"));
  assert.strictEqual((await probe()).find((x) => x.checkId === "stripe")!.status, "skip");
});

test("stripe → fail 403", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_stripe";
  const f = makeFetch({ "https://api.stripe.com": fakeResponse(403) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "stripe");
  assert.strictEqual(r!.status, "fail");
  assert.strictEqual(r!.error, "HTTP 403");
});

test("proxy_publico → ok quando 401 (estado saudável)", async () => {
  const url = "https://zinom.ai/mcp";
  const f = makeFetch({ [url]: fakeResponse(401) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "proxy_publico");
  assert.strictEqual(r!.status, "ok");
  assert.strictEqual(r!.group, "entrada");
  assert.strictEqual(r!.label, "Entrada pública (zinom.ai/mcp)");
  assert.strictEqual(r!.detail?.httpStatus, 401);
});

test("proxy_publico → fail quando 200", async () => {
  const f = makeFetch({ "https://zinom.ai": fakeResponse(200) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "proxy_publico");
  assert.strictEqual(r!.status, "fail");
  assert.ok(r!.detail?.httpStatus === 200);
});

test("proxy_publico → fail quando 404", async () => {
  const f = makeFetch({ "https://zinom.ai": fakeResponse(404) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  assert.strictEqual(results.find((x) => x.checkId === "proxy_publico")!.status, "fail");
});

test("proxy_publico → usa HEALTH_PUBLIC_URL quando definida", async () => {
  process.env.HEALTH_PUBLIC_URL = "https://custom.example.com/mcp";
  let calledUrl = "";
  const f: typeof fetch = async (input) => {
    calledUrl = typeof input === "string" ? input : (input as Request).url;
    return fakeResponse(401);
  };
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  assert.ok(calledUrl.startsWith("https://custom.example.com"), `URL errada: ${calledUrl}`);
  assert.strictEqual(results.find((x) => x.checkId === "proxy_publico")!.status, "ok");
});

test("ntfy → ok 2xx via GET /v1/health na raiz do servidor", async () => {
  process.env.NTFY_URL = "https://ntfy.sh/zinom-test";
  const urls: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith("https://ntfy.sh")) {
      urls.push(url);
      assert.strictEqual(init?.method, "GET");
      return fakeResponse(200, { healthy: true });
    }
    return fakeResponse(200, {});
  };
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "ntfy");
  assert.strictEqual(r!.status, "ok");
  assert.strictEqual(r!.label, "ntfy");
  assert.strictEqual(r!.group, "parceiros");
  // O tópico NÃO é consultado (HEAD no tópico dá 404 no ntfy): vai em /v1/health.
  assert.deepStrictEqual(urls, ["https://ntfy.sh/v1/health"]);
});

test("ntfy → fail quando não-2xx", async () => {
  process.env.NTFY_URL = "https://ntfy.sh/zinom-test";
  const f = makeFetch({ "https://ntfy.sh": fakeResponse(503) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  assert.strictEqual(results.find((x) => x.checkId === "ntfy")!.status, "fail");
  assert.strictEqual(results.find((x) => x.checkId === "ntfy")!.error, "HTTP 503");
});

test("ntfy → skip sem NTFY_URL", async () => {
  const [probe] = makeExternalProbes(errorFetch("não deve chamar"));
  assert.strictEqual((await probe()).find((x) => x.checkId === "ntfy")!.status, "skip");
});

test("exceção no fetch → fail com mensagem truncada a 200 chars", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const longMsg = "x".repeat(300);
  const f = errorFetch(longMsg);
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "anthropic");
  assert.strictEqual(r!.status, "fail");
  assert.ok(r!.error!.length <= 200, `erro deve ter ≤ 200 chars, tem ${r!.error!.length}`);
});

test("latência é registrada para checks ok", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const f = makeFetch({ "https://api.resend.com": fakeResponse(200, {}) });
  const [probe] = makeExternalProbes(f);
  const results = await probe();
  const r = results.find((x) => x.checkId === "resend");
  assert.ok(typeof r!.latencyMs === "number" && r!.latencyMs >= 0);
});
