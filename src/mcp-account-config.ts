// src/mcp-account-config.ts
// WS2 — per-account MCP server configuration (instructions + ownership check),
// extracted from index.ts so it is pure and unit-testable (no server boot).
// Security note: ownership is decided ONLY from the trusted request context's
// accountId (set by the auth layer), never from tool input.
import { DEFAULT_ACCOUNT_ID, type RequestContext } from "./context.js";

/** True when the request is the operator/owner (full notion_* suite + full
 *  INSTRUCTIONS), false for an onboarded friend account (restricted, safe set).
 *
 *  FAIL-CLOSED: owner requires a POSITIVE signal — the static "all" bearer, the
 *  default account, or an explicit operator flag set by the auth layer. The mere
 *  absence of accountId is NOT owner: a friend OAuth token that reaches /mcp
 *  without a populated accountId (legacy persisted token, refresh edge, dropped
 *  field) must fall to the friend tool set, never inherit the owner's tools +
 *  private workspace names. `undefined` ctx = out-of-request (cron/eval/startup),
 *  trusted/internal, treated as owner. */
export function isOwnerContext(ctx: RequestContext | undefined): boolean {
  if (!ctx) return true; // internal: cron / eval / startup (no HTTP request)
  if (ctx.scopes === "all") return true; // static BEARER_TOKEN (Claude Code)
  if (ctx.accountId === DEFAULT_ACCOUNT_ID) return true; // the operator's own account
  if (ctx.accountId) return false; // any other account = friend / per-account → never owner
  return ctx.isOperator === true; // no accountId: owner ONLY if positively flagged
}

/** Pure classifier the auth layer uses to decide ctx.isOperator for an OAuth
 *  token that carries NO accountId. Operator iff: scopes === "all", an explicit
 *  kind "operator" (new tokens), or — bridge for pre-flag tokens — the token is
 *  scoped only to the operator's own known workspaces. A token with an accountId
 *  is a friend and is NEVER operator. `knownWorkspaces` is the operator's
 *  configured workspace set (ALL_WORKSPACES), injected to keep this pure. */
export function isOperatorToken(
  info: { accountId?: string; scopes: string[] | "all"; kind?: string },
  knownWorkspaces: readonly string[],
): boolean {
  if (info.accountId) return false; // has a tenant → friend, never operator
  if (info.scopes === "all") return true;
  if (info.kind === "operator") return true;
  return (
    Array.isArray(info.scopes) &&
    info.scopes.length > 0 &&
    info.scopes.every((s) => knownWorkspaces.includes(s))
  );
}

// A FRIEND account must NOT receive the owner's INSTRUCTIONS: those name Bruno's
// three private workspaces + house rules, which would (a) leak his structure and
// (b) tell the friend's AI to use workspaces it doesn't have. Friends get a short,
// generic brief describing only the tools they actually have. A friend may connect
// several workspaces with arbitrary names, so we never enumerate workspace names.
export const FRIEND_INSTRUCTIONS = `
Você é o Zinom desta pessoa — um segundo cérebro pesquisável conectado às fontes dela (páginas do Notion, reuniões do Granola e eventos de calendário que ela conectou).

Ferramentas disponíveis:
- **brain_search** — busca semântica + textual no segundo cérebro da pessoa. Use para responder qualquer pergunta sobre as reuniões, notas, decisões, pessoas e compromissos dela. Cada resultado traz \`title\`, \`source_type\` (notion/granola/calendar) e \`source_url\`. SEMPRE cite as fontes que usou como links markdown — [title](source_url) — dizendo se é página do Notion, reunião do Granola ou evento do Calendar. Quando \`source_url\` for null (alguns eventos de calendário não têm link próprio), cite pelo título + data (metadata.data).
- **zinom_create_task** — cria uma tarefa, evento, compromisso ou lembrete no Notion da pessoa (base "Tarefas"), com data opcional. Use quando ela pedir para agendar, marcar, criar tarefa/evento ou ser lembrada de algo. Converta expressões como "hoje", "amanhã", "sexta 20h" em data ISO 8601 absoluta usando a data atual.
- **brain_index_web** — indexa um link da web no Zinom quando a pessoa pedir ("indexa isso", "guarda esse link").

Regras:
- Responda em **português (Brasil)**, de forma direta e útil.
- Você só enxerga os dados desta conta. Nunca invente fontes nem resultados.
- Se uma busca não retornar nada e a pessoa tiver conectado fontes há pouco, oriente-a a abrir o portal (zinom.ai) e clicar em "Indexar agora".
`.trim();
