// src/classifier/anthropic.ts
// Wrapper around Anthropic SDK for classification.
import Anthropic from "@anthropic-ai/sdk";
import type { ClassificationResult, Frente, ReuniaoTipo, InsightCategoria, PageToClassify } from "./types.js";
import { validateClassification } from "./validate.js";
import { recordLlmUsage, type LlmUsage } from "../llm-usage.js";

/** Injectable metering function for callHaiku (tests replace with a no-op or spy). */
export type HaikuMeterFn = (accountId: string, usage: LlmUsage, label: string) => Promise<void>;

let _haikuMeter: HaikuMeterFn = recordLlmUsage;

/** Test-only seam: replace the meter used internally by callHaiku. Pass null to restore. */
export function __setHaikuMeterForTest(fn: HaikuMeterFn | null): void {
  _haikuMeter = fn ?? recordLlmUsage;
}

const MODEL = process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Usage counts returned alongside the generated text. */
export interface HaikuUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Result of a callHaiku invocation: text + token usage. */
export interface HaikuResult {
  text: string;
  usage: HaikuUsage;
}

/**
 * Generic "ask Haiku" helper: one system prompt + one user message, returns the
 * concatenated text AND usage (input/output tokens) for metering.
 * Reusable beyond classification (e.g. an eval LLM-judge).
 *
 * When `accountId` is provided, meters token usage against that account
 * best-effort INTERNALLY (fire-and-forget) using `label` as the tag.
 * This ensures call sites that were not metering before cannot forget to meter.
 *
 * NOTE: `classifyPage` accumulates usage across retries and meters AFTER the
 * retry loop, so it calls callHaiku WITHOUT an accountId to avoid double-counting.
 */
export async function callHaiku(
  system: string,
  user: string,
  accountId?: string,
  label = "haiku",
): Promise<HaikuResult> {
  const c = getClient();
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 512,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage: HaikuUsage = {
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
  };
  // Meter best-effort when accountId is provided. classifyPage intentionally
  // does NOT pass accountId here (it meters the total after retry aggregation).
  if (accountId) {
    _haikuMeter(accountId, usage, label).catch(() => {/* swallowed — best-effort */});
  }
  return { text, usage };
}

const SYSTEM_PROMPT = `Você é um classificador de notas do "segundo cérebro" do Bruno Moniz.

Bruno é co-founder de DUAS empresas:
- **Global Cripto**: exchange/PSAV cripto-financeira no Brasil, regulamentada pelo BACEN. Produtos: Firebit (app retail) e custódia dedicada. Parceiros: Parfin, Talos, Fireblocks, Selcoin, Inter, Efí, Chainalysis, B2C2. Time inclui Mila (saiu), Jorge (tech lead), Ana (QA), José Junior, Matheus Campos, Igor, Gabriel Paiva.
- **Nora Finance**: emissora de stablecoin BRS (Brazilian Real Stablecoin). Sócios: Bruno (Moniz), Jean, Luigi Remor, Victor Cioffi. Acelerada por Pinheiro Neto e Uniswap Foundation.

Frentes possíveis (use exatamente um destes valores): "Global Cripto" | "Nora Finance" | "Pessoal" | "Conteudo"

Tipos de Reunião (use exatamente um): "1:1" | "Time interno" | "Cliente" | "Parceiro" | "Juridico" | "Investidor" | "Pessoal" | "Outro"

Categorias de Insight (use exatamente um): "Estrategia" | "Regulacao" | "Produto" | "Mercado" | "Pessoas" | "Operacional" | "Pessoal"

Responda APENAS com JSON válido. Sem markdown, sem texto explicativo.`;

/**
 * Classify a Notion page with Haiku. Meters token usage against accountId
 * (defaults to "bruno", the owner, which is who the cron runs as).
 * Injectable `meter` for tests.
 */
export async function classifyPage(
  page: PageToClassify,
  accountId = "bruno",
  meter: typeof recordLlmUsage = recordLlmUsage,
): Promise<ClassificationResult> {
  const userPrompt = buildUserPrompt(page);

  let result = await callHaiku(SYSTEM_PROMPT, userPrompt);
  // Accumulate usage across retries.
  const totalUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };

  let parsed: ClassificationResult;
  try {
    parsed = parseJsonResponse(result.text, page.db);
  } catch (err) {
    // 1-retry JSON repair: re-ask Haiku for STRICT JSON only when the first
    // response was malformed (no parseable JSON object).
    result = await callHaiku(
      SYSTEM_PROMPT,
      `${userPrompt}\n\n---\nSua resposta anterior não era JSON válido. Responda APENAS com o objeto JSON pedido, sem markdown, sem texto antes ou depois.`,
    );
    totalUsage.input_tokens += result.usage.input_tokens;
    totalUsage.output_tokens += result.usage.output_tokens;
    parsed = parseJsonResponse(result.text, page.db);
  }

  // Meter token usage best-effort (fire-and-forget pattern).
  meter(accountId, totalUsage, "classifier").catch(() => {/* swallowed */});

  // Enum validation: drop any hallucinated frente/tipo/categoria so a value
  // outside the union in types.ts is never propagated to Notion.
  const validated = validateClassification(parsed);
  return {
    frente: page.db === "Reunioes" ? ((validated.frente as Frente | undefined) ?? null) : null,
    tipo: page.db === "Reunioes" ? ((validated.tipo as ReuniaoTipo | undefined) ?? null) : null,
    categoria: page.db === "Insights" ? ((validated.categoria as InsightCategoria | undefined) ?? null) : null,
    pessoas: validated.pessoas,
    organizacoes: validated.organizacoes,
  };
}

function buildUserPrompt(page: PageToClassify): string {
  const props = page.current_props;
  const lines: string[] = [];

  if (page.db === "Reunioes") {
    lines.push("Classifique a reunião abaixo. Retorne JSON com este shape:");
    lines.push(
      `{"frente": "Global Cripto"|"Nora Finance"|"Pessoal"|"Conteudo", "tipo": "1:1"|"Time interno"|"Cliente"|"Parceiro"|"Juridico"|"Investidor"|"Pessoal"|"Outro", "pessoas": ["Nome 1", "Nome 2"], "organizacoes": ["Org 1"]}`,
    );
    lines.push("");
    lines.push("- `pessoas`: nomes de pessoas mencionadas no conteúdo (excluindo Bruno, Moniz). Máximo 10. Se não houver, retorne [].");
    lines.push("- `organizacoes`: nomes de empresas/orgs mencionadas (ex: 'Parfin', 'Inter', 'Pinheiro Neto', 'Selcoin'). Máximo 10. Se não houver, retorne [].");
    if (props.frente) lines.push(`- Frente atual: "${props.frente}" (mantenha se não tiver razão pra mudar).`);
    if (props.tipo) lines.push(`- Tipo atual: "${props.tipo}" (mantenha se não tiver razão pra mudar).`);
  } else {
    lines.push("Classifique o insight abaixo. Retorne JSON com este shape:");
    lines.push(
      `{"categoria": "Estrategia"|"Regulacao"|"Produto"|"Mercado"|"Pessoas"|"Operacional"|"Pessoal", "pessoas": ["Nome 1"], "organizacoes": ["Org 1"]}`,
    );
    lines.push("");
    lines.push("- `pessoas`/`organizacoes`: como acima.");
    if (props.categoria) lines.push(`- Categoria atual: "${props.categoria}" (mantenha se possível).`);
  }

  lines.push("");
  lines.push("---");
  lines.push(`Título: ${page.title}`);
  lines.push("");
  lines.push("Conteúdo:");
  lines.push(page.body.slice(0, 6000));
  lines.push("---");
  return lines.join("\n");
}

function parseJsonResponse(text: string, db: PageToClassify["db"]): ClassificationResult {
  // Extract first JSON object — be lenient about leading/trailing whitespace or markdown
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);
  }
  const json = text.slice(start, end + 1);
  const parsed = JSON.parse(json);

  return {
    frente: db === "Reunioes" ? parsed.frente ?? null : null,
    tipo: db === "Reunioes" ? parsed.tipo ?? null : null,
    categoria: db === "Insights" ? parsed.categoria ?? null : null,
    pessoas: Array.isArray(parsed.pessoas) ? parsed.pessoas.slice(0, 10) : [],
    organizacoes: Array.isArray(parsed.organizacoes) ? parsed.organizacoes.slice(0, 10) : [],
  };
}
