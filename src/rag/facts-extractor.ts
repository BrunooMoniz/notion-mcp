// src/rag/facts-extractor.ts
// F2.3 — extraction entry point. This is the ONLY facts module that performs an
// LLM call, so it is kept isolated: it reuses the existing Anthropic wrapper
// (callHaiku in classifier/anthropic.ts — same Haiku model, same lazy SDK init),
// and never instantiates a new SDK path. The parsing/normalization/prompt logic
// is pure and lives in ./facts.ts.
//
// SAFETY: FACTS_ENABLED gates the whole feature off by default. Always-on code
// paths (the classifier) import this module DYNAMICALLY inside their gated block
// so that, when the gate is off, this file is never loaded and no SDK init is
// triggered for facts.
import { callHaiku } from "../classifier/anthropic.js";
import {
  buildFactExtractionPrompt,
  normalizeFact,
  parseFactsResponse,
  type Fact,
  type FactContext,
} from "./facts.js";

/** Master kill switch. Production behaves exactly as today unless this is "true". */
export const FACTS_ENABLED = process.env.FACTS_ENABLED === "true";

const SYSTEM_PROMPT =
  'Você é um extrator de fatos duráveis para o "segundo cérebro" do Bruno. ' +
  "Responda APENAS com um array JSON estrito de fatos sujeito-predicado-objeto. " +
  "You only output a strict JSON array of subject-predicate-object facts.";

/**
 * Extract durable facts from a passage: build the prompt, call Haiku, then parse
 * + normalize. Provenance (workspace/source_id/source_type) is filled from ctx
 * via normalizeFact, so it is authoritative regardless of what the model echoes.
 * Returns [] on an empty passage or when the model finds no durable facts.
 */
export async function extractFactsFromText(text: string, ctx: FactContext): Promise<Fact[]> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];

  const prompt = buildFactExtractionPrompt(trimmed, ctx);
  const { text: raw } = await callHaiku(SYSTEM_PROMPT, prompt);

  // parseFactsResponse already drops items missing s/p/o; normalizeFact then
  // fills provenance from ctx, clamps confidence, and validates dates.
  const parsed = parseFactsResponse(raw);
  const out: Fact[] = [];
  for (const item of parsed) {
    const norm = normalizeFact(item, ctx);
    if (norm) out.push(norm);
  }
  return out;
}
