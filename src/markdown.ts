/**
 * Markdown ↔ Notion block conversion utilities.
 *
 * Supports: headings, paragraphs, bullet/numbered lists, code blocks,
 * blockquotes, dividers, to-do items, and inline formatting (bold, italic,
 * strikethrough, inline code, links).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface RichText {
  type: "text";
  text: { content: string; link: { url: string } | null };
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
}

type BlockObject = Record<string, unknown>;

// ─── Markdown → Notion blocks ────────────────────────────────────────────────

/** Parse inline markdown into Notion rich_text array. */
function parseInline(text: string): RichText[] {
  const result: RichText[] = [];
  // Regex handles: [text](url), **bold**, *italic*, ~~strike~~, `code`
  const re =
    /\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Push preceding plain text
    if (match.index > lastIndex) {
      result.push(makeText(text.slice(lastIndex, match.index)));
    }

    if (match[1] !== undefined) {
      // Link [text](url)
      result.push(makeText(match[1], { link: match[2] }));
    } else if (match[3] !== undefined) {
      // Bold
      result.push(makeText(match[3], { bold: true }));
    } else if (match[4] !== undefined) {
      // Italic
      result.push(makeText(match[4], { italic: true }));
    } else if (match[5] !== undefined) {
      // Strikethrough
      result.push(makeText(match[5], { strikethrough: true }));
    } else if (match[6] !== undefined) {
      // Inline code
      result.push(makeText(match[6], { code: true }));
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(makeText(text.slice(lastIndex)));
  }

  if (result.length === 0) {
    result.push(makeText(""));
  }

  return result;
}

function makeText(
  content: string,
  opts: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    link?: string;
  } = {}
): RichText {
  return {
    type: "text",
    text: {
      content,
      link: opts.link ? { url: opts.link } : null,
    },
    annotations: {
      bold: opts.bold ?? false,
      italic: opts.italic ?? false,
      strikethrough: opts.strikethrough ?? false,
      underline: false,
      code: opts.code ?? false,
      color: "default",
    },
  };
}

/** Convert a Markdown string into an array of Notion block objects. */
export function markdownToBlocks(md: string): BlockObject[] {
  const lines = md.split("\n");
  const blocks: BlockObject[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plain text";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: [makeText(codeLines.join("\n"))],
          language: lang,
        },
      });
      continue;
    }

    // Divider
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const type = `heading_${level}` as const;
      blocks.push({
        object: "block",
        type,
        [type]: { rich_text: parseInline(headingMatch[2]) },
      });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: parseInline(line.slice(2)) },
      });
      i++;
      continue;
    }

    // To-do
    const todoMatch = line.match(/^- \[([ xX])\]\s+(.+)$/);
    if (todoMatch) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: parseInline(todoMatch[2]),
          checked: todoMatch[1].toLowerCase() === "x",
        },
      });
      i++;
      continue;
    }

    // Bulleted list
    if (/^[-*]\s+/.test(line)) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: parseInline(line.replace(/^[-*]\s+/, "")),
        },
      });
      i++;
      continue;
    }

    // Numbered list
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: parseInline(numberedMatch[1]),
        },
      });
      i++;
      continue;
    }

    // Empty line → skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (default)
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: parseInline(line) },
    });
    i++;
  }

  return blocks;
}

// ─── Notion blocks → Markdown ────────────────────────────────────────────────

function richTextToMd(richTexts: RichText[]): string {
  return richTexts
    .map((rt) => {
      let text = rt.text.content;
      if (!text) return "";

      if (rt.annotations.code) text = `\`${text}\``;
      if (rt.annotations.bold) text = `**${text}**`;
      if (rt.annotations.italic) text = `*${text}*`;
      if (rt.annotations.strikethrough) text = `~~${text}~~`;
      if (rt.text.link) text = `[${text}](${rt.text.link.url})`;

      return text;
    })
    .join("");
}

/** Convert an array of Notion block objects into a Markdown string. */
export function blocksToMarkdown(blocks: BlockObject[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const type = block.type as string;
    const data = block[type] as Record<string, unknown> | undefined;
    if (!data) continue;

    const rt = data.rich_text as RichText[] | undefined;

    switch (type) {
      case "heading_1":
        lines.push(`# ${richTextToMd(rt ?? [])}`);
        break;
      case "heading_2":
        lines.push(`## ${richTextToMd(rt ?? [])}`);
        break;
      case "heading_3":
        lines.push(`### ${richTextToMd(rt ?? [])}`);
        break;
      case "paragraph":
        lines.push(richTextToMd(rt ?? []));
        break;
      case "bulleted_list_item":
        lines.push(`- ${richTextToMd(rt ?? [])}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${richTextToMd(rt ?? [])}`);
        break;
      case "to_do": {
        const checked = (data.checked as boolean) ? "x" : " ";
        lines.push(`- [${checked}] ${richTextToMd(rt ?? [])}`);
        break;
      }
      case "quote":
        lines.push(`> ${richTextToMd(rt ?? [])}`);
        break;
      case "code": {
        const lang = (data.language as string) || "";
        lines.push(`\`\`\`${lang}`);
        lines.push(richTextToMd(rt ?? []));
        lines.push("```");
        break;
      }
      case "divider":
        lines.push("---");
        break;
      case "callout": {
        const icon = (data.icon as Record<string, string>)?.emoji ?? "";
        lines.push(`> ${icon} ${richTextToMd(rt ?? [])}`);
        break;
      }
      case "toggle":
        lines.push(`<details><summary>${richTextToMd(rt ?? [])}</summary></details>`);
        break;
      case "image": {
        const imgData = data as Record<string, Record<string, string>>;
        const url = imgData.file?.url ?? imgData.external?.url ?? "";
        const caption = rt ? richTextToMd(rt) : "";
        lines.push(`![${caption}](${url})`);
        break;
      }
      case "bookmark": {
        const bookmarkUrl = (data.url as string) ?? "";
        lines.push(`[${bookmarkUrl}](${bookmarkUrl})`);
        break;
      }
      case "table_of_contents":
        lines.push("[Table of Contents]");
        break;
      case "child_page":
        lines.push(`📄 [${data.title as string}]`);
        break;
      case "child_database":
        lines.push(`🗃️ [${data.title as string}]`);
        break;
      default:
        if (rt) lines.push(richTextToMd(rt));
        break;
    }
  }

  return lines.join("\n");
}

// ─── Database schema → Markdown ──────────────────────────────────────────────

export function schemaToMarkdown(
  properties: Record<string, Record<string, unknown>>
): string {
  const lines: string[] = ["## Database Schema", "", "| Property | Type | Details |", "|----------|------|---------|"];

  for (const [name, prop] of Object.entries(properties)) {
    const type = prop.type as string;
    let details = "";

    switch (type) {
      case "select":
      case "multi_select": {
        const options = (prop[type] as Record<string, unknown>)?.options as
          | Array<{ name: string; color: string }>
          | undefined;
        if (options?.length) {
          details = options.map((o) => o.name).join(", ");
        }
        break;
      }
      case "relation": {
        const rel = prop.relation as Record<string, string> | undefined;
        if (rel?.database_id) details = `→ ${rel.database_id}`;
        break;
      }
      case "rollup": {
        const rollup = prop.rollup as Record<string, string> | undefined;
        if (rollup) details = `${rollup.function}(${rollup.relation_property_name}.${rollup.rollup_property_name})`;
        break;
      }
      case "formula": {
        const formula = prop.formula as Record<string, string> | undefined;
        if (formula?.expression) details = formula.expression;
        break;
      }
      case "number": {
        const fmt = (prop.number as Record<string, string>)?.format;
        if (fmt) details = fmt;
        break;
      }
      default:
        break;
    }

    lines.push(`| ${name} | ${type} | ${details} |`);
  }

  return lines.join("\n");
}

// ─── Page properties → Markdown ──────────────────────────────────────────────

export function propertiesToMarkdown(
  properties: Record<string, Record<string, unknown>>
): string {
  const lines: string[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const type = prop.type as string;
    let value = "";

    switch (type) {
      case "title": {
        const titleArr = prop.title as RichText[] | undefined;
        value = titleArr ? richTextToMd(titleArr) : "";
        break;
      }
      case "rich_text": {
        const rtArr = prop.rich_text as RichText[] | undefined;
        value = rtArr ? richTextToMd(rtArr) : "";
        break;
      }
      case "number":
        value = prop.number != null ? String(prop.number) : "";
        break;
      case "select": {
        const sel = prop.select as { name: string } | null;
        value = sel?.name ?? "";
        break;
      }
      case "multi_select": {
        const ms = prop.multi_select as Array<{ name: string }> | undefined;
        value = ms?.map((s) => s.name).join(", ") ?? "";
        break;
      }
      case "date": {
        const d = prop.date as { start: string; end?: string } | null;
        if (d) value = d.end ? `${d.start} → ${d.end}` : d.start;
        break;
      }
      case "checkbox":
        value = (prop.checkbox as boolean) ? "✓" : "✗";
        break;
      case "url":
        value = (prop.url as string) ?? "";
        break;
      case "email":
        value = (prop.email as string) ?? "";
        break;
      case "phone_number":
        value = (prop.phone_number as string) ?? "";
        break;
      case "status": {
        const st = prop.status as { name: string } | null;
        value = st?.name ?? "";
        break;
      }
      case "people": {
        const people = prop.people as Array<{ name?: string }> | undefined;
        value = people?.map((p) => p.name ?? "?").join(", ") ?? "";
        break;
      }
      case "relation": {
        const rels = prop.relation as Array<{ id: string }> | undefined;
        value = rels?.map((r) => r.id).join(", ") ?? "";
        break;
      }
      case "formula": {
        const f = prop.formula as Record<string, unknown> | undefined;
        if (f) {
          const fType = f.type as string;
          value = f[fType] != null ? String(f[fType]) : "";
        }
        break;
      }
      default:
        value = `[${type}]`;
        break;
    }

    if (value) lines.push(`- **${name}**: ${value}`);
  }

  return lines.join("\n");
}
