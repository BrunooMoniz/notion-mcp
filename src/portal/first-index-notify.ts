// src/portal/first-index-notify.ts
// "Avisaremos quando a primeira indexação terminar": após um reindex disparado
// pelo portal terminar com conteúdo indexado, envia UM e-mail (uma vez por
// conta, flag no vault) avisando que o Zinom está pronto. Deps injetáveis para
// teste; falha de e-mail nunca propaga (o reindex já terminou com sucesso).
import { getAccountSecret, setAccountSecret } from "../secrets.js";
import { getAccountEmail } from "./accounts.js";
import { sendFirstIndexDoneEmail } from "./email.js";

const NOTIFIED_KIND = "first_index_notified";

export interface FirstIndexNotifyDeps {
  getAccountSecret(accountId: string, kind: string): Promise<string | null>;
  setAccountSecret(accountId: string, kind: string, value: string): Promise<void>;
  getAccountEmail(accountId: string): Promise<string | null>;
  sendEmail(to: string, totals: { documents: number; chunks: number }): Promise<void>;
}

const realDeps: FirstIndexNotifyDeps = {
  getAccountSecret,
  setAccountSecret,
  getAccountEmail,
  sendEmail: (to, totals) => sendFirstIndexDoneEmail(to, totals),
};

/**
 * Notify the account ONCE that its first indexing finished. No-ops when the
 * run indexed nothing (an empty first run is not "pronto") or when the account
 * was already notified. Returns true when an email was sent.
 */
export async function notifyFirstIndexDone(
  accountId: string,
  totals: { documents: number; chunks: number },
  deps: FirstIndexNotifyDeps = realDeps,
): Promise<boolean> {
  if ((totals.documents ?? 0) <= 0 && (totals.chunks ?? 0) <= 0) return false;
  try {
    if (await deps.getAccountSecret(accountId, NOTIFIED_KIND)) return false;
    const email = await deps.getAccountEmail(accountId);
    if (!email) return false;
    // Flag BEFORE sending: a duplicated email is worse than a missing one
    // (re-runs happen on every reindex; the send failure path is logged).
    await deps.setAccountSecret(accountId, NOTIFIED_KIND, new Date().toISOString());
    await deps.sendEmail(email, totals);
    return true;
  } catch (err: any) {
    console.warn(`[portal] first-index notify ${accountId}: ${err?.message ?? err}`);
    return false;
  }
}
