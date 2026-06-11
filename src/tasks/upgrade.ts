// src/tasks/upgrade.ts
// 003-tasks-v1 — ADDITIVE upgrade of the standard "Tarefas" tracker to the new
// template (task-tracker-schema.ts TARGET_PROPERTIES). SAFETY: only ever
// patches the tracker the account has configured AND whose title is exactly
// "Tarefas" (the Zinom-created base) — never an arbitrary user base. Never
// removes or renames anything; only adds missing properties and missing select
// options (existing options re-sent with their ids so they are preserved).
//
// API shape (verified via context7 — /llmstxt/developers_notion_llms_txt,
// "Update a data source", https://developers.notion.com/reference/update-a-data-source
// + upgrade-guide-2025-09-03): under Notion-Version 2025-09-03 the schema PATCH
// is `PATCH /v1/data_sources/{data_source_id}` with the schema under the
// `properties` key (NOT `schema`), keyed by property NAME, e.g.
// { "properties": { "Quem": { "rich_text": {} } } }. A `null` value would
// REMOVE a property — this module never sends null.
import { TARGET_PROPERTIES, TARGET_DB_TITLE } from "../portal/task-tracker-schema.js";
import {
  loadTrackerProfile,
  invalidateTrackerProfile,
  rawNotionFetch,
  rawErrorMessage,
  buildTrackerProfile,
  type AdapterDeps,
  type TrackerProfile,
} from "./adapter.js";
import { normalize } from "./model.js";
import { auditWrite } from "../audit.js";

/** The tracker exists but is not the Zinom-standard "Tarefas" base — we never
 *  mutate the schema of a base the user brought themselves. */
export class NotStandardTrackerError extends Error {
  constructor(title: string) {
    super(
      `só atualizo o template padrão "${TARGET_DB_TITLE}" criado pelo Zinom; a base configurada ("${title}") é sua e eu não mexo no schema dela`,
    );
    this.name = "NotStandardTrackerError";
  }
}

/** Which canonical field each TARGET property represents, so an OLD base that
 *  already covers the field under another name (e.g. "Frente" → projeto,
 *  "Tempo estimado" → tempo) does NOT get a duplicate column added. */
const TARGET_FIELD: Record<string, keyof TrackerProfile["props"]> = {
  Nome: "title",
  Status: "status",
  Prioridade: "prioridade",
  Prazo: "prazo",
  "Tempo estimado (min)": "tempo",
  Tipo: "tipo",
  Quem: "quem",
  Origem: "origem",
  Projeto: "projeto",
  "Criada em": "criada_em",
  "Concluída em": "concluida_em",
};

/** PURE: diff an existing schema against TARGET_PROPERTIES. Returns the PATCH
 *  `properties` body (empty = nothing to do) + a human list of what was added.
 *  - property missing AND canonical field uncovered → add it;
 *  - property exists by name and both are selects → merge missing options,
 *    re-sending the existing options WITH their ids (preserved, never removed);
 *  - status-type props are left alone (their options aren't editable via API). */
export function buildUpgradeDiff(existing: Record<string, any>): {
  properties: Record<string, unknown>;
  added: string[];
} {
  const profile = buildTrackerProfile({ id: "diff", title: TARGET_DB_TITLE, properties: existing });
  const properties: Record<string, unknown> = {};
  const added: string[] = [];

  const existingByNorm = new Map<string, [string, any]>();
  for (const [name, def] of Object.entries(existing ?? {})) {
    existingByNorm.set(normalize(name), [name, def]);
  }

  for (const [targetName, targetDef] of Object.entries(TARGET_PROPERTIES)) {
    const hit = existingByNorm.get(normalize(targetName));
    if (hit) {
      const [realName, realDef] = hit;
      const targetOptions: Array<{ name: string; color?: string }> =
        targetDef?.select?.options ?? [];
      if (targetOptions.length && realDef?.type === "select") {
        const realOptions: any[] = realDef?.select?.options ?? [];
        const have = new Set(realOptions.map((o: any) => normalize(o?.name ?? "")));
        const missingOpts = targetOptions.filter((o) => !have.has(normalize(o.name)));
        if (missingOpts.length) {
          // Existing options re-sent with id (+ color) so they are preserved.
          const merged = [
            ...realOptions.map((o: any) => {
              const keep: Record<string, unknown> = { name: o?.name };
              if (o?.id) keep.id = o.id;
              if (o?.color) keep.color = o.color;
              return keep;
            }),
            ...missingOpts,
          ];
          properties[realName] = { select: { options: merged } };
          added.push(`${targetName} (opções: ${missingOpts.map((o) => o.name).join(", ")})`);
        }
      }
      continue; // present by name: never retype/rename
    }

    // Not present by name: skip when another property already covers the same
    // canonical field (synonym mapping, e.g. Frente→projeto).
    const field = TARGET_FIELD[targetName];
    if (field && field !== "title" && (profile.props as Record<string, unknown>)[field]) continue;
    if (field === "title") continue; // a data source always has its title prop

    properties[targetName] = targetDef;
    added.push(targetName);
  }

  return { properties, added };
}

export interface UpgradeResult {
  ok: true;
  added: string[];
}

/** Additively upgrade the account's STANDARD tracker (title "Tarefas") to the
 *  current template. Throws NotStandardTrackerError for any other base. */
export async function upgradeStandardTracker(
  accountId: string,
  deps: AdapterDeps = {},
): Promise<UpgradeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ctx = await loadTrackerProfile(accountId, deps);

  // Re-read the schema fresh (the cached profile may be up to 5 min old and the
  // profile doesn't carry the raw property defs the diff needs).
  const ds = await rawNotionFetch(
    ctx.token,
    `/v1/data_sources/${ctx.profile.dataSourceId}`,
    { method: "GET" },
    fetchImpl,
  );
  if (!ds.ok) throw new Error(rawErrorMessage(`/v1/data_sources/${ctx.profile.dataSourceId}`, ds));

  const title = Array.isArray(ds.data?.title)
    ? ds.data.title.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("").trim()
    : String(ds.data?.title ?? "");
  if (normalize(title) !== normalize(TARGET_DB_TITLE)) {
    throw new NotStandardTrackerError(title || "(sem título)");
  }

  const { properties, added } = buildUpgradeDiff(ds.data?.properties ?? {});
  if (Object.keys(properties).length === 0) return { ok: true, added: [] };

  const r = await rawNotionFetch(
    ctx.token,
    `/v1/data_sources/${ctx.profile.dataSourceId}`,
    { method: "PATCH", body: JSON.stringify({ properties }) },
    fetchImpl,
  );
  if (!r.ok) throw new Error(rawErrorMessage(`/v1/data_sources/${ctx.profile.dataSourceId}`, r));

  // Schema mutation = write → audit trail, same convention as the task writes.
  auditWrite(
    "upgrade_standard_tracker",
    "tasks",
    { account_id: accountId, data_source_id: ctx.profile.dataSourceId },
    { added },
  );

  invalidateTrackerProfile(accountId);
  return { ok: true, added };
}
