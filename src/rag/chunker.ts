// src/rag/chunker.ts

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  maxTokens?: number;
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = opts.targetTokens ?? 500;
  const overlap = opts.overlapTokens ?? 50;
  const max = opts.maxTokens ?? 800;

  const trimmed = text.trim();
  if (!trimmed) return [];

  const sections = splitByHeadings(trimmed);
  if (sections.length === 1 && estimateTokens(trimmed) <= target) return [trimmed];
  const chunks: string[] = [];

  for (const section of sections) {
    if (estimateTokens(section) <= max) {
      chunks.push(...packParagraphs(section, target, overlap, max));
    } else {
      chunks.push(...packSentences(section, target, overlap, max));
    }
  }

  return chunks.filter((c) => c.trim().length > 0);
}

function splitByHeadings(text: string): string[] {
  const parts: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length > 0) {
      parts.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) parts.push(current.join("\n").trim());
  return parts.filter((p) => p.length > 0);
}

function packParagraphs(text: string, target: number, overlap: number, max: number): string[] {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p);
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (bufTokens + paraTokens > max && buf.length > 0) {
      chunks.push(buf.join("\n\n"));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join("\n\n"));
    }
    buf.push(para);
    bufTokens += paraTokens;
    if (bufTokens >= target) {
      chunks.push(buf.join("\n\n"));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join("\n\n"));
    }
  }
  if (buf.length > 0) chunks.push(buf.join("\n\n"));
  return chunks;
}

function packSentences(text: string, target: number, overlap: number, max: number): string[] {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s);
  const chunks: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  for (const s of sentences) {
    const t = estimateTokens(s);
    if (bufTokens + t > max && buf.length > 0) {
      chunks.push(buf.join(" "));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join(" "));
    }
    buf.push(s);
    bufTokens += t;
    if (bufTokens >= target) {
      chunks.push(buf.join(" "));
      buf = takeTail(buf, overlap);
      bufTokens = estimateTokens(buf.join(" "));
    }
  }
  if (buf.length > 0) chunks.push(buf.join(" "));
  return chunks;
}

function takeTail(parts: string[], targetTokens: number): string[] {
  const out: string[] = [];
  let acc = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    out.unshift(parts[i]);
    acc += estimateTokens(parts[i]);
    if (acc >= targetTokens) break;
  }
  return out;
}
