// src/portal/activation.ts
// 001-account-portal / ativação — estado do checklist one-time, derivado das
// fontes conectadas + tasks_db_id + um flag "ask"/"dismissed" no vault (kind
// "activation"). Sem migração. complete = 4 itens OU dismissed (p/ esconder).
import { getAccountSecret, setAccountSecret } from "../secrets.js";
import { getTasksDbId } from "./task-tracker.js";
import { getGranolaMasked, getIcalLinks } from "./sources.js";

const ACTIVATION_KIND = "activation";

interface ActivationFlags {
  ask?: boolean;
  dismissed?: boolean;
}

async function readFlags(accountId: string): Promise<ActivationFlags> {
  const raw = await getAccountSecret(accountId, ACTIVATION_KIND);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as ActivationFlags) : {};
  } catch {
    return {};
  }
}

async function writeFlags(accountId: string, patch: ActivationFlags): Promise<void> {
  const next = { ...(await readFlags(accountId)), ...patch };
  await setAccountSecret(accountId, ACTIVATION_KIND, JSON.stringify(next));
}

export interface ActivationState {
  items: { tasks: boolean; granola: boolean; ical: boolean; ask: boolean };
  dismissed: boolean;
  complete: boolean;
}

export async function getActivationState(accountId: string): Promise<ActivationState> {
  const flags = await readFlags(accountId);
  const tasks = (await getTasksDbId(accountId)) != null;
  const granola = (await getGranolaMasked(accountId)).set;
  const ical = (await getIcalLinks(accountId)).length > 0;
  const ask = flags.ask === true;
  const items = { tasks, granola, ical, ask };
  const allDone = tasks && granola && ical && ask;
  const dismissed = flags.dismissed === true;
  return { items, dismissed, complete: allDone || dismissed };
}

export async function markAsked(accountId: string): Promise<void> {
  await writeFlags(accountId, { ask: true });
}

export async function dismissActivation(accountId: string): Promise<void> {
  await writeFlags(accountId, { dismissed: true });
}
