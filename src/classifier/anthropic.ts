// src/classifier/anthropic.ts
// Wrapper around Anthropic SDK for classification.
import Anthropic from "@anthropic-ai/sdk";
import type { ClassificationResult, PageToClassify } from "./types.js";

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

const SYSTEM_PROMPT = `Você é um classificador de notas do "segundo cérebro" do Bruno Moniz.

Bruno é co-founder de DUAS empresas:
- **Global Cripto**: exchange/PSAV cripto-financeira no Brasil, regulamentada pelo BACEN. Produtos: Firebit (app retail) e custódia dedicada. Parceiros: Parfin, Talos, Fireblocks, Selcoin, Inter, Efí, Chainalysis, B2C2. Time inclui Mila (saiu), Jorge (tech lead), Ana (QA), José Junior, Matheus Campos, Igor, Gabriel Paiva.
- **Nora Finance**: emissora de stablecoin BRS (Brazilian Real Stablecoin). Sócios: Bruno (Moniz), Jean, Luigi Remor, Victor Cioffi. Acelerada por Pinheiro Neto e Uniswap Foundation.

Frentes possíveis (use exatamente um destes valores): "Global Cripto" | "Nora Finance" | "Pessoal" | "Conteudo"

Tipos de Reunião (use exatamente um): "1:1" | "Time interno" | "Cliente" | "Parceiro" | "Juridico" | "Investidor" | "Pessoal" | "Outro"

Categorias de Insight (use exatamente um): "Estrategia" | "Regulacao" | "Produto" | "Mercado" | "Pessoas" | "Operacional" | "Pessoal"

Responda APENAS com JSON válido. Sem markdown, sem texto explicativo.`;

export async function classifyPage(page: PageToClassify): Promise<ClassificationResult> {
  const c = getClient();

  const userPrompt = buildUserPrompt(page);

  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return parseJsonResponse(text, page.db);
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
