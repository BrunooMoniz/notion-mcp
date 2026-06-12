// src/health/probes-external.ts
// Probe de APIs parceiras para o painel de saúde.
// Spec: docs/superpowers/specs/2026-06-11-admin-health-dashboard-design.md (tarefa TB)
//
// Nota: NOTION_API_VERSION não é importado de "../clients.js" porque clients.ts
// executa process.exit(1) em tempo de importação quando os tokens Notion estão
// ausentes — o que quebraria os testes. O valor é inlineado aqui; se mudar em
// clients.ts, deve ser atualizado também aqui.
import type { CheckResult, HealthGroup, HealthStatus, Probe } from "./types.js";

const NOTION_API_VERSION = "2025-09-03";

const TIMEOUT_MS = 8_000;

// ---------- helper interno ----------

interface TimedResult {
  status?: number;
  ms: number;
  err?: string;
  body?: unknown;
}

async function timed(
  f: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<TimedResult> {
  const t0 = performance.now();
  try {
    const res = await f(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Math.round(performance.now() - t0);
    // Lê body só quando necessário (stripe detail). Para os demais, descartamos.
    let body: unknown;
    try {
      const text = await res.text();
      if (text) body = JSON.parse(text);
    } catch {
      // body não-JSON: ignorado
    }
    return { status: res.status, ms, body };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const raw = String(err);
    return { ms, err: raw.slice(0, 200) };
  }
}

function httpError(status: number): string {
  return `HTTP ${status}`;
}

function buildResult(
  checkId: string,
  label: string,
  group: HealthGroup,
  t: TimedResult,
  okWhen: (status: number) => boolean,
  detail?: Record<string, unknown>,
): CheckResult {
  if (t.err !== undefined) {
    return { checkId, label, group, status: "fail", latencyMs: t.ms, error: t.err };
  }
  const ok = okWhen(t.status!);
  const status: HealthStatus = ok ? "ok" : "fail";
  const error = ok ? undefined : httpError(t.status!);
  return { checkId, label, group, status, latencyMs: t.ms, ...(detail ? { detail } : {}), ...(error ? { error } : {}) };
}

// ---------- checagens individuais ----------

async function checkNotion(
  workspace: "personal" | "globalcripto" | "nora",
  token: string,
  f: typeof fetch,
): Promise<CheckResult> {
  const labels: Record<string, string> = {
    personal: "Notion (personal)",
    globalcripto: "Notion (globalcripto)",
    nora: "Notion (nora)",
  };
  const checkId = `notion:${workspace}`;
  const label = labels[workspace];
  const t = await timed(f, "https://api.notion.com/v1/users/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
    },
  });
  return buildResult(checkId, label, "parceiros", t, (s) => s >= 200 && s < 300);
}

async function checkAnthropic(f: typeof fetch): Promise<CheckResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { checkId: "anthropic", label: "Anthropic API", group: "parceiros", status: "skip" };
  const t = await timed(f, "https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  return buildResult("anthropic", "Anthropic API", "parceiros", t, (s) => s >= 200 && s < 300);
}

async function checkVoyage(f: typeof fetch): Promise<CheckResult> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return { checkId: "voyage", label: "Voyage AI", group: "parceiros", status: "skip" };
  const url = process.env.VOYAGE_EMBEDDINGS_URL ?? "https://api.voyageai.com/v1/embeddings";
  const t = await timed(f, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: ["ping"], model: "voyage-3-large" }),
  });
  return buildResult("voyage", "Voyage AI", "parceiros", t, (s) => s >= 200 && s < 300);
}

async function checkResend(f: typeof fetch): Promise<CheckResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { checkId: "resend", label: "Resend", group: "parceiros", status: "skip" };
  const t = await timed(f, "https://api.resend.com/domains", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return buildResult("resend", "Resend", "parceiros", t, (s) => s >= 200 && s < 300);
}

async function checkStripe(f: typeof fetch): Promise<CheckResult> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return { checkId: "stripe", label: "Stripe", group: "parceiros", status: "skip" };
  const t = await timed(f, "https://api.stripe.com/v1/balance", {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (t.err !== undefined) {
    return { checkId: "stripe", label: "Stripe", group: "parceiros", status: "fail", latencyMs: t.ms, error: t.err };
  }
  const ok = t.status! >= 200 && t.status! < 300;
  if (!ok) {
    return { checkId: "stripe", label: "Stripe", group: "parceiros", status: "fail", latencyMs: t.ms, error: httpError(t.status!) };
  }
  // Extrai available e pending do JSON de resposta.
  const body = t.body as { available?: Array<{ amount: number; currency: string }>; pending?: Array<{ amount: number; currency: string }> } | undefined;
  const detail: Record<string, unknown> = {
    available: body?.available ?? [],
    pending: body?.pending ?? [],
  };
  return { checkId: "stripe", label: "Stripe", group: "parceiros", status: "ok", latencyMs: t.ms, detail };
}

async function checkProxyPublico(f: typeof fetch): Promise<CheckResult> {
  const url = process.env.HEALTH_PUBLIC_URL ?? "https://zinom.ai/mcp";
  const t = await timed(f, url, { method: "GET" });
  if (t.err !== undefined) {
    return {
      checkId: "proxy_publico",
      label: "Entrada pública (zinom.ai/mcp)",
      group: "entrada",
      status: "fail",
      latencyMs: t.ms,
      error: t.err,
    };
  }
  const httpStatus = t.status!;
  const ok = httpStatus === 401;
  return {
    checkId: "proxy_publico",
    label: "Entrada pública (zinom.ai/mcp)",
    group: "entrada",
    status: ok ? "ok" : "fail",
    latencyMs: t.ms,
    detail: { httpStatus },
    ...(ok ? {} : { error: `HTTP ${httpStatus}` }),
  };
}

async function checkNtfy(f: typeof fetch): Promise<CheckResult> {
  const url = process.env.NTFY_URL;
  if (!url) return { checkId: "ntfy", label: "ntfy", group: "parceiros", status: "skip" };
  const t = await timed(f, url, { method: "HEAD" });
  return buildResult("ntfy", "ntfy", "parceiros", t, (s) => s >= 200 && s < 300);
}

// ---------- export principal ----------

/**
 * Cria um array com um único Probe que roda todas as checagens de APIs
 * parceiras em paralelo e retorna CheckResult[].
 *
 * O parâmetro `f` é o fetch a usar — substitua nos testes para evitar I/O real.
 * As envs são lidas no momento da execução do probe (não em makeExternalProbes),
 * para que os testes possam setar/limpar envs após a construção.
 */
export function makeExternalProbes(f: typeof fetch = fetch): Probe[] {
  const probe: Probe = async () => {
    // Notion: um check por workspace, somente se o token estiver presente.
    const notionChecks: Promise<CheckResult>[] = [];
    const notionWorkspaces = [
      { id: "personal" as const, env: "NOTION_PERSONAL_TOKEN" },
      { id: "globalcripto" as const, env: "NOTION_GLOBALCRIPTO_TOKEN" },
      { id: "nora" as const, env: "NOTION_NORA_TOKEN" },
    ];
    for (const { id, env } of notionWorkspaces) {
      const token = process.env[env];
      if (token) {
        notionChecks.push(checkNotion(id, token, f));
      } else {
        notionChecks.push(
          Promise.resolve({
            checkId: `notion:${id}`,
            label: id === "personal" ? "Notion (personal)" : id === "globalcripto" ? "Notion (globalcripto)" : "Notion (nora)",
            group: "parceiros" as const,
            status: "skip" as const,
          }),
        );
      }
    }

    const results = await Promise.all([
      ...notionChecks,
      checkAnthropic(f),
      checkVoyage(f),
      checkResend(f),
      checkStripe(f),
      checkProxyPublico(f),
      checkNtfy(f),
    ]);

    return results;
  };

  return [probe];
}
