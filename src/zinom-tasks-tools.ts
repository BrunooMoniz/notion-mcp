// src/zinom-tasks-tools.ts
// 003-tasks-v1 — the task tools (create / list / update / plan context),
// registered for FRIEND **and** OWNER surfaces (replaces the friend-only
// zinom-task-tool.ts). Account-scoped by construction: the account always
// comes from getAccountId() (trusted request context), never from tool input.
// Each handler has its own try/catch (friends don't get tools.ts's error
// wrapper) and every write is audited (auditWrite), like the calendar tools.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccountId } from "./context.js";
import { auditWrite } from "./audit.js";
import { listTasks } from "./tasks/read.js";
import { createTask, updateTask, type UpdateTaskPatch } from "./tasks/write.js";
import { NoNotionError, NoTrackerError, TaskNotFoundError } from "./tasks/adapter.js";
import {
  computeFreeSlots,
  dedupPlanEvents,
  groupOpenTasks,
  validatePlanWindow,
  isValidTimezone,
  zonedTimeToUtc,
  localDateInTz,
  isoInTz,
  stripBracketPrefix,
  PLAN_GUIDANCE,
  DEFAULT_TIMEZONE,
  DEFAULT_WORK_START,
  DEFAULT_WORK_END,
  type PlanEvent,
} from "./tasks/plan-context.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function fail(error: string, message: string) {
  return json({ ok: false, error, message });
}

const NO_NOTION_MSG =
  "Você ainda não conectou um Notion. Abra o portal (zinom.ai) e conecte seu Notion para eu poder trabalhar com suas tarefas.";
const NO_TRACKER_MSG =
  "Você ainda não tem uma base de tarefas configurada. Duas saídas: (1) peça para eu criar sua primeira tarefa — eu crio a base padrão \"Tarefas\" no seu Notion automaticamente; ou (2) configure uma base existente no portal (zinom.ai → Início → Tarefas).";

function taskError(e: unknown, genericCode = "task_failed"): ReturnType<typeof fail> {
  if (e instanceof NoNotionError) return fail("no_notion", NO_NOTION_MSG);
  if (e instanceof NoTrackerError) return fail("no_tracker", NO_TRACKER_MSG);
  if (e instanceof TaskNotFoundError) {
    return fail(
      "not_found",
      "Não encontrei essa tarefa na sua base (task_id inválido ou de outra base). Use zinom_list_tasks para pegar o id certo.",
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  return fail(genericCode, msg);
}

// --- zinom_setup_tasks: núcleo puro (deps injetáveis) -------------------------

export interface SetupTasksDeps {
  getTasksDbId: (accountId: string) => Promise<string | null>;
  createTaskTracker: (
    accountId: string,
    opts: { workspace?: string; parentPageId?: string },
  ) => Promise<{ dataSourceId: string; created: boolean }>;
  searchParentPages: (
    accountId: string,
    q: string,
    opts: { workspace?: string },
  ) => Promise<Array<{ id: string; title: string; url: string | null; workspace: string }>>;
  findWorkspaceForPage: (
    accountId: string,
    pageId: string,
  ) => Promise<{ workspace: string; title: string; url: string | null } | null>;
  getTasksInfo: (accountId: string) => Promise<{ title: string | null; url: string | null }>;
  invalidateTrackerProfile: (accountId: string) => void;
  extractNotionPageId: (s: string) => string | null;
}

export interface SetupTasksArgs { pagina?: string; workspace?: string; confirmar?: boolean }

/** Núcleo puro (deps injetáveis) da zinom_setup_tasks — retorna o objeto JSON da
 *  resposta. Mantido separado do handler para ser testável sem rede/DB. */
export async function setupTasksFlow(
  accountId: string,
  args: SetupTasksArgs,
  deps: SetupTasksDeps,
): Promise<Record<string, unknown>> {
  const existing = await deps.getTasksDbId(accountId);
  if (existing && !args.confirmar) {
    let info: { title: string | null; url: string | null } = { title: null, url: null };
    try { info = await deps.getTasksInfo(accountId); } catch { /* sem link */ }
    return {
      ok: false,
      error: "already_configured",
      title: info.title,
      tracker_url: info.url,
      message:
        "Você já tem uma base de Tarefas configurada" + (info.url ? `: ${info.url}` : ".") +
        " Para criar uma NOVA base em outro lugar e passar a usá-la, chame de novo com confirmar=true" +
        " (a base antiga continua no seu Notion; as tarefas não são migradas automaticamente).",
    };
  }

  let parentPageId: string | undefined;
  let targetWorkspace = args.workspace;
  let parentTitle: string | null = null;

  const pagina = args.pagina?.trim();
  if (pagina) {
    const direct = deps.extractNotionPageId(pagina);
    if (direct) {
      parentPageId = direct;
      if (!targetWorkspace) {
        const hit = await deps.findWorkspaceForPage(accountId, direct);
        if (!hit) {
          return {
            ok: false, error: "page_not_accessible",
            message: "Não consegui ler essa página com nenhum Notion conectado. Confira se a integração do Zinom tem acesso a ela (Share → conexões) e tente de novo.",
          };
        }
        targetWorkspace = hit.workspace;
        parentTitle = hit.title;
      }
    } else {
      const candidates = await deps.searchParentPages(accountId, pagina, { workspace: targetWorkspace });
      if (candidates.length === 0) {
        return {
          ok: false, error: "page_not_found",
          message: `Não achei nenhuma página chamada "${pagina}" nos Notion conectados. Ela existe e a integração tem acesso? Você também pode mandar a URL da página.`,
        };
      }
      if (candidates.length > 1) {
        return {
          ok: false, error: "ambiguous_page", candidates,
          message: "Achei mais de uma página com esse nome — qual delas? Responda com a URL ou o id.",
        };
      }
      parentPageId = candidates[0].id;
      targetWorkspace = candidates[0].workspace;
      parentTitle = candidates[0].title;
    }
  }

  const r = await deps.createTaskTracker(accountId, { workspace: targetWorkspace, parentPageId });
  deps.invalidateTrackerProfile(accountId);
  let info: { title: string | null; url: string | null } = { title: null, url: null };
  try { info = await deps.getTasksInfo(accountId); } catch { /* sem link */ }
  const onde = parentTitle ? `dentro da página "${parentTitle}"` : 'na página "🧠 Zinom" no topo do workspace';
  return {
    ok: true,
    created: r.created,
    data_source_id: r.dataSourceId,
    title: info.title ?? "Tarefas",
    tracker_url: info.url,
    workspace: targetWorkspace ?? null,
    message: r.created
      ? `Base de Tarefas criada ${onde}.` + (info.url ? ` Abra aqui: ${info.url}` : "") +
        " Dica: no Notion dá para mudar a visualização da base para Board (kanban)."
      : `Encontrei uma base "Tarefas" existente e passei a usá-la.` + (info.url ? ` Abra aqui: ${info.url}` : ""),
  };
}

export function registerZinomTasksTools(server: McpServer): void {
  // --- zinom_create_task (retrocompatível + campos canônicos novos) -----------
  server.tool(
    "zinom_create_task",
    `Cria uma tarefa, evento, compromisso ou lembrete no Notion da pessoa (na base de tarefas dela), com data opcional.

Use SEMPRE que a pessoa pedir para "criar uma tarefa", "agendar", "marcar", "me lembrar de", "anotar pra fazer", ou quando você extrair tarefas de uma reunião. Se ela ainda não tiver base de tarefas, o Zinom cria a padrão automaticamente na primeira vez.

ANTES de criar, rode zinom_list_tasks com q (busca por título) para não duplicar uma tarefa que já existe no board.

Fazer vs Cobrar: tipo='fazer' é algo que a PESSOA vai executar; tipo='cobrar' é algo que ela precisa COBRAR de alguém — nesse caso preencha 'quem' com a pessoa cobrada. Tarefa extraída de reunião: preencha origem_url com o link da reunião.

Parâmetros:
- titulo (obrigatório): nome da tarefa/evento.
- data: início ISO 8601 (ex.: "2026-06-09" ou "2026-06-09T20:00:00-03:00"). Converta "hoje", "amanhã", "sexta 20h" em data absoluta usando a data atual.
- fim: fim ISO 8601 para RESERVAR UM BLOCO DE TEMPO (só com 'data').
- status: aceita canônico (backlog | todo | in_progress | blocked | done | canceled) ou o nome literal da opção na base ("A fazer", "Em andamento", ...).
- prioridade: urgente | alta | media | baixa.
- tempo_estimado_min: estimativa em minutos.
- tipo: fazer | cobrar.
- quem: de quem cobrar / responsável (texto).
- origem_url: link de origem (reunião do Granola, página, e-mail).
- projeto: nome do projeto/frente.
- nota: detalhe livre no corpo da página.

Responde em português confirmando o que foi criado, com o link da página.`,
    {
      titulo: z.string().min(1).describe("Nome da tarefa/evento"),
      data: z
        .string()
        .optional()
        .describe('Início ISO 8601, ex.: "2026-06-09" ou "2026-06-09T20:00:00-03:00"'),
      fim: z
        .string()
        .optional()
        .describe('Fim ISO 8601 para bloco de tempo, ex.: "2026-06-09T16:00:00-03:00" (só com data)'),
      status: z
        .string()
        .optional()
        .describe('Canônico (todo, in_progress, done, ...) ou literal ("A fazer")'),
      prioridade: z.string().optional().describe("urgente | alta | media | baixa"),
      tempo_estimado_min: z.number().int().positive().optional().describe("Estimativa em minutos"),
      tipo: z
        .string()
        .optional()
        .describe("fazer | cobrar (ou o valor literal da sua base)"),
      quem: z.string().optional().describe("De quem cobrar / responsável (texto)"),
      origem_url: z.string().optional().describe("Link de origem (reunião, página)"),
      projeto: z.string().optional().describe("Projeto/frente"),
      nota: z.string().optional().describe("Detalhe livre para o corpo da página"),
    },
    async ({ titulo, data, fim, status, prioridade, tempo_estimado_min, tipo, quem, origem_url, projeto, nota }) => {
      const accountId = getAccountId();
      try {
        const r = await createTask(accountId, {
          title: titulo,
          prazo: data,
          prazo_fim: fim,
          status,
          prioridade,
          tempo_estimado_min,
          tipo,
          quem,
          origem_url,
          projeto,
          note: nota,
        });
        auditWrite(
          "zinom_create_task",
          "tasks",
          { account_id: accountId, data_source_id: r.dataSourceId, page_id: r.pageId },
          { titulo },
        );
        return json({
          ok: true,
          created: r.created, // true if the Tarefas base was created on first use
          titulo,
          data: data ?? null,
          url: r.url,
          message: r.created
            ? "Criei sua base de Tarefas no Notion e adicionei este item."
            : "Tarefa criada no seu Notion.",
        });
      } catch (e) {
        return taskError(e, "create_failed");
      }
    },
  );

  // --- zinom_setup_tasks ---------------------------------------------------------
  server.tool(
    "zinom_setup_tasks",
    `Configura ONDE vive a base de Tarefas (Kanban) da pessoa no Notion: cria a base dentro da página e do workspace que ela apontar, e retorna o link clicável do board. PREFIRA esta tool a criar databases por conectores nativos do Notion.

Use quando a pessoa pedir "criar minha base de tarefas", "mudar minhas tarefas para a página X", "criar o kanban dentro de Y", ou reclamar de onde o board foi criado.

Parâmetros:
- pagina: URL ou ID de uma página do Notion, OU o nome da página para eu procurar ("Projetos 2026"). Sem 'pagina', crio a página "🧠 Zinom" no topo do workspace.
- workspace: opcional; restringe a busca/criação a um workspace específico (para quem tem mais de um Notion conectado).
- confirmar: obrigatório =true quando JÁ existe uma base configurada — cria a nova no destino e passa a usá-la (a antiga continua no Notion; as tarefas NÃO são migradas automaticamente).

Se a resposta trouxer candidates (mais de uma página com o nome), mostre as opções com os links e pergunte qual usar. Responda SEMPRE com o link clicável do board (tracker_url).`,
    {
      pagina: z.string().optional().describe("URL/ID da página, ou nome para buscar"),
      workspace: z.string().optional().describe("Workspace específico (opcional)"),
      confirmar: z.boolean().optional().describe("true para substituir uma base já configurada"),
    },
    async ({ pagina, workspace, confirmar }) => {
      const accountId = getAccountId();
      try {
        const tracker = await import("./portal/task-tracker.js");
        const schema = await import("./portal/task-tracker-schema.js");
        const adapter = await import("./tasks/adapter.js");
        const out = await setupTasksFlow(accountId, { pagina, workspace, confirmar }, {
          getTasksDbId: tracker.getTasksDbId,
          createTaskTracker: (a, o) => tracker.createTaskTracker(a, o),
          searchParentPages: (a, q, o) => tracker.searchParentPages(a, q, o),
          findWorkspaceForPage: (a, p) => tracker.findWorkspaceForPage(a, p),
          getTasksInfo: (a) => adapter.getTasksInfo(a),
          invalidateTrackerProfile: adapter.invalidateTrackerProfile,
          extractNotionPageId: schema.extractNotionPageId,
        });
        if ((out as any).ok) {
          auditWrite("zinom_setup_tasks", "tasks",
            { account_id: accountId, data_source_id: (out as any).data_source_id },
            { workspace: (out as any).workspace });
        }
        return json(out);
      } catch (e) {
        return taskError(e, "setup_failed");
      }
    },
  );

  // --- zinom_list_tasks --------------------------------------------------------
  server.tool(
    "zinom_list_tasks",
    `Lista as tarefas da base de tarefas da pessoa, com o resumo do board. Leitura pura: nunca cria nada.

Use para: "o que tenho pra fazer?", revisar o board, listar cobranças pendentes (filtre tipo='cobrar' no resultado), e SEMPRE antes de zinom_create_task (busque com q para não criar duplicata).

Parâmetros:
- status: array de status canônicos (backlog, todo, in_progress, blocked, done, canceled) ou nomes literais. Sem filtro, retorna as abertas.
- incluir_concluidas: inclui done/canceled (default false).
- prazo_de / prazo_ate: janela de prazo (YYYY-MM-DD).
- q: busca por substring no título (use para deduplicar antes de criar).
- limit: máximo de tarefas (default 25, máx 100).

Retorna {tasks, board, tracker_url, truncated}: tasks no modelo canônico (id, title, status, prioridade, prazo, tempo_estimado_min, tipo, quem, origem_url, projeto), board com contagem por status + minutos estimados dos abertos + overdue_count. truncated=true significa que a base tem mais linhas do que o scan cobriu — os números do board são um piso.`,
    {
      status: z
        .array(z.string())
        .optional()
        .describe("Status canônicos (todo, in_progress, ...) ou literais"),
      incluir_concluidas: z.boolean().optional().describe("Incluir done/canceled (default false)"),
      prazo_de: z.string().optional().describe("Prazo a partir de (YYYY-MM-DD)"),
      prazo_ate: z.string().optional().describe("Prazo até (YYYY-MM-DD)"),
      q: z.string().optional().describe("Busca por título (dedup antes de criar)"),
      limit: z.number().int().positive().optional().describe("Default 25, máx 100"),
    },
    async ({ status, incluir_concluidas, prazo_de, prazo_ate, q, limit }) => {
      const accountId = getAccountId();
      try {
        const r = await listTasks(accountId, {
          status,
          incluir_concluidas,
          prazo_de,
          prazo_ate,
          q,
          limit,
        });
        return json({
          ok: true,
          tasks: r.tasks,
          board: r.board,
          tracker_url: r.tracker_url,
          truncated: r.truncated,
        });
      } catch (e) {
        return taskError(e);
      }
    },
  );

  // --- zinom_update_task -------------------------------------------------------
  server.tool(
    "zinom_update_task",
    `Atualiza uma tarefa existente: mover status (concluir, bloquear, iniciar), repriorizar, dar prazo, estimar tempo, renomear, ou registrar uma cobrança feita via nota_append.

Pegue o task_id em zinom_list_tasks. Só os campos passados são alterados. Concluir = status 'done' (a data de conclusão é preenchida automaticamente quando a base tem o campo). Cobrança feita: nota_append com "Cobrei X em <data>".

Parâmetros:
- task_id (obrigatório): id da tarefa (de zinom_list_tasks).
- titulo: novo título.
- status: canônico (backlog | todo | in_progress | blocked | done | canceled) ou literal da base.
- prioridade: urgente | alta | media | baixa.
- prazo: novo prazo ISO 8601 ("" limpa o prazo); prazo_fim: fim do bloco (só com prazo).
- tempo_estimado_min, tipo (fazer|cobrar ou literal da base), quem.
- projeto: SUBSTITUI o conjunto de tags do projeto (em base multi_select, passe a lista completa separada por vírgula, ex.: "Zinom, Nora").
- nota_append: parágrafo adicionado ao corpo da página (histórico/cobranças).`,
    {
      task_id: z.string().min(1).describe("Id da tarefa (de zinom_list_tasks)"),
      titulo: z.string().optional(),
      status: z.string().optional().describe("Canônico ou literal da base"),
      prioridade: z.string().optional().describe("urgente | alta | media | baixa"),
      prazo: z.string().optional().describe('ISO 8601; "" limpa o prazo'),
      prazo_fim: z.string().optional().describe("Fim do bloco (só com prazo)"),
      tempo_estimado_min: z.number().int().positive().optional(),
      tipo: z.string().optional().describe("fazer | cobrar (ou o valor literal da sua base)"),
      quem: z.string().optional(),
      projeto: z
        .string()
        .optional()
        .describe('Substitui o conjunto de tags; multi_select: lista separada por vírgula ("Zinom, Nora")'),
      nota_append: z.string().optional().describe("Parágrafo adicionado ao corpo da página"),
    },
    async ({ task_id, ...patch }) => {
      const accountId = getAccountId();
      try {
        const task = await updateTask(accountId, task_id, patch as UpdateTaskPatch);
        auditWrite(
          "zinom_update_task",
          "tasks",
          { account_id: accountId, page_id: task_id },
          { fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) },
        );
        return json({ ok: true, task, message: "Tarefa atualizada." });
      } catch (e) {
        return taskError(e);
      }
    },
  );

  // --- zinom_plan_context --------------------------------------------------------
  server.tool(
    "zinom_plan_context",
    `Retorna TUDO que você precisa para planejar o dia/semana/mês da pessoa numa chamada só: agenda real (eventos ao vivo de todas as contas Google conectadas, em união com os eventos indexados no cérebro — estes marcados approximate, sem duração exata), janelas livres por dia, e o board de tarefas abertas agrupado por status.

Use quando pedirem "planeja meu dia/semana/mês", "o que cabe na minha agenda", "distribui minhas tarefas". Janela máxima: 35 dias. Não usa quota de busca.

Parâmetros:
- period_start / period_end (obrigatórios, YYYY-MM-DD): a janela do plano.
- timezone: IANA (default America/Sao_Paulo).
- work_start / work_end: janela de trabalho diária (default 09:00–19:00).
- include_weekends: incluir sáb/dom nos slots (default false).

Retorna:
- events: {title, start, end, all_day, calendar}, dedup por título+início.
- free_slots: por dia, janelas livres em horário local (eventos de dia inteiro NÃO bloqueiam).
- tasks: abertas agrupadas por status (backlog, todo, in_progress, blocked) com prioridade/prazo/estimativa; overdue em destaque.
- totals: {free_min, abertos, estimado_min, overdue}.
- guidance: como transformar isso em plano (alocar, criar blocktime, atualizar o board).`,
    {
      period_start: z.string().describe("Início da janela (YYYY-MM-DD)"),
      period_end: z.string().describe("Fim da janela (YYYY-MM-DD, máx 35 dias)"),
      timezone: z.string().optional().describe("IANA, default America/Sao_Paulo"),
      work_start: z.string().optional().describe('Início do expediente, default "09:00"'),
      work_end: z.string().optional().describe('Fim do expediente, default "19:00"'),
      include_weekends: z.boolean().optional().describe("Default false"),
    },
    async ({ period_start, period_end, timezone, work_start, work_end, include_weekends }) => {
      const accountId = getAccountId();
      try {
        const windowError = validatePlanWindow(period_start, period_end);
        if (windowError) return fail("invalid_window", windowError);
        const tz = timezone ?? DEFAULT_TIMEZONE;
        if (!isValidTimezone(tz)) {
          return fail("invalid_timezone", `timezone IANA inválida: "${tz}" (ex.: America/Sao_Paulo)`);
        }
        const ws = work_start ?? DEFAULT_WORK_START;
        const we = work_end ?? DEFAULT_WORK_END;
        if (!/^\d{2}:\d{2}$/.test(ws) || !/^\d{2}:\d{2}$/.test(we)) {
          return fail("invalid_work_window", 'work_start/work_end devem ser "HH:MM"');
        }

        // --- events: live Google (all accounts/calendars), brain fallback ----
        const events = dedupPlanEvents(
          await gatherEvents(accountId, period_start, period_end, tz),
        ).sort((a, b) => a.start.localeCompare(b.start));

        const free_slots = computeFreeSlots(events, {
          period_start,
          period_end,
          timezone: tz,
          work_start: ws,
          work_end: we,
          include_weekends: include_weekends ?? false,
        });

        // --- open tasks grouped by status (no tracker → empty, never create) -
        // "Today" (overdue cut) in the USER's timezone, not the server clock.
        const todayISO = localDateInTz(tz);
        let tasksSection: ReturnType<typeof groupOpenTasks> = { by_status: {}, overdue: [] };
        let abertos = 0;
        let estimado_min = 0;
        let tasks_truncated = false;
        let tracker_note: string | null = null;
        try {
          const r = await listTasks(accountId, { limit: 100 });
          tasksSection = groupOpenTasks(r.tasks, todayISO);
          abertos = r.board.abertos;
          estimado_min = r.board.estimado_min;
          tasks_truncated = r.truncated;
        } catch (e) {
          if (e instanceof NoNotionError) {
            tracker_note = NO_NOTION_MSG;
          } else if (e instanceof NoTrackerError) {
            tracker_note = NO_TRACKER_MSG;
          } else {
            throw e;
          }
        }

        const free_min = free_slots.reduce((acc, d) => acc + d.free_min, 0);
        const hasApproximate = events.some((e) => e.approximate);
        return json({
          ok: true,
          period: { start: period_start, end: period_end, timezone: tz },
          events,
          free_slots,
          tasks: tasksSection.by_status,
          overdue: tasksSection.overdue,
          // tasks_truncated=true → abertos/estimado/overdue são um PISO (a base
          // tem mais linhas do que o scan cobriu).
          totals: { free_min, abertos, estimado_min, overdue: tasksSection.overdue.length, tasks_truncated },
          ...(hasApproximate
            ? {
                note:
                  "Parte da agenda veio do índice do cérebro (eventos approximate, sem duração exata). Conecte o Google no portal para horários precisos.",
              }
            : {}),
          ...(tracker_note ? { tracker_note } : {}),
          guidance: PLAN_GUIDANCE,
        });
      } catch (e) {
        return taskError(e);
      }
    },
  );
}

// --- event gathering (live Google ∪ brain-indexed iCal) -----------------------

/** Max calendars considered for busy-time per Google account (cost bound). */
export const MAX_BUSY_CALENDARS = 10;

interface CalendarLite {
  id: string;
  summary?: string;
  accessRole?: string;
}

interface GoogleEventLite {
  summary?: string;
  status?: string;
  transparency?: string;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** PURE: calendars that represent the person's own time — accessRole
 *  owner/writer only (subscribed/read-only feeds like holidays don't block
 *  slots), capped at MAX_BUSY_CALENDARS (truncation logged). */
export function busyCalendars(cals: CalendarLite[], label: string): CalendarLite[] {
  const own = cals.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
  if (own.length > MAX_BUSY_CALENDARS) {
    console.warn(`[plan-context] ${label}: ${own.length} calendars, using first ${MAX_BUSY_CALENDARS}`);
    return own.slice(0, MAX_BUSY_CALENDARS);
  }
  return own;
}

/** PURE: true when the event actually blocks a slot — skips cancelled,
 *  "free"/transparent events and events the person declined. */
export function eventBlocksBusy(e: GoogleEventLite): boolean {
  if (e.status === "cancelled") return false;
  if (e.transparency === "transparent") return false;
  const self = (e.attendees ?? []).find((a) => a?.self);
  if (self?.responseStatus === "declined") return false;
  return true;
}

export interface BrainCalendarRow {
  text?: string;
  data: string | null;
  calendar_label: string | null;
}

/** PURE: brain-indexed calendar rows → approximate PlanEvents. Titles lose the
 *  contextual bracket header; timed starts are re-expressed in the user's tz
 *  offset and re-cut to the LOCAL-date window (a 22h BRT event stored as
 *  01:00Z next day must not leak into the following day). */
export function brainRowsToPlanEvents(
  rows: BrainCalendarRow[],
  periodStart: string,
  periodEnd: string,
  tz: string,
): PlanEvent[] {
  const out: PlanEvent[] = [];
  for (const r of rows) {
    if (!r.data) continue;
    const firstLine = (r.text ?? "").split("\n")[0] ?? "";
    const title = stripBracketPrefix(firstLine.replace(/^#\s+/, "").trim()) || "(sem título)";
    const timed = /T/.test(r.data);
    let start = r.data;
    let localDate = r.data.slice(0, 10);
    if (timed) {
      const parsed = new Date(r.data);
      if (!Number.isNaN(parsed.getTime())) {
        start = isoInTz(parsed, tz);
        localDate = start.slice(0, 10);
      }
    }
    if (localDate < periodStart || localDate > periodEnd) continue;
    out.push({
      title,
      start,
      end: null,
      all_day: !timed,
      calendar: r.calendar_label ?? "",
      approximate: true,
    });
  }
  return out;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Injectable seams for tests (defaults do the real dynamic imports). */
export interface GatherEventsDeps {
  getGoogleAccounts?: (accountId: string) => Promise<Array<{ email: string }>>;
  getAccessToken?: (accountId: string, email: string) => Promise<string>;
  listCalendars?: (token: string) => Promise<CalendarLite[]>;
  listEvents?: (
    token: string,
    opts: { calendarId: string; timeMin: string; timeMax: string },
  ) => Promise<GoogleEventLite[]>;
  queryBrainRows?: (accountId: string, from: string, to: string) => Promise<BrainCalendarRow[]>;
}

async function defaultQueryBrainRows(
  accountId: string,
  from: string,
  to: string,
): Promise<BrainCalendarRow[]> {
  const { getPool } = await import("./rag/storage.js");
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (source_id)
            source_id,
            text,
            metadata->>'data'           AS data,
            metadata->>'calendar_label' AS calendar_label
     FROM brain_chunks
     WHERE source_type = 'calendar'
       AND account_id = $1
       AND (metadata->>'data')::date >= $2::date
       AND (metadata->>'data')::date <= $3::date
     ORDER BY source_id, chunk_index ASC`,
    [accountId, from, to],
  );
  return rows as BrainCalendarRow[];
}

export async function gatherEvents(
  accountId: string,
  periodStart: string,
  periodEnd: string,
  tz: string,
  deps: GatherEventsDeps = {},
): Promise<PlanEvent[]> {
  const events: PlanEvent[] = [];

  // --- live Google: all accounts, busy calendars in parallel ----------------
  try {
    const getAccounts =
      deps.getGoogleAccounts ?? (await import("./google/google-accounts.js")).getGoogleAccounts;
    const getToken =
      deps.getAccessToken ?? (await import("./google/google-token.js")).getGoogleAccessTokenFor;
    const calendarMod =
      deps.listCalendars && deps.listEvents ? null : await import("./google/calendar.js");
    const listCals = deps.listCalendars ?? calendarMod!.listCalendarsWithToken;
    const listEvs = deps.listEvents ?? calendarMod!.listEventsWithToken;

    const timeMin = zonedTimeToUtc(periodStart, "00:00", tz).toISOString();
    // End of the last day = start of the following day in the local timezone.
    const timeMax = zonedTimeToUtc(shiftDate(periodEnd, 1), "00:00", tz).toISOString();

    for (const acc of await getAccounts(accountId)) {
      try {
        const token = await getToken(accountId, acc.email);
        const cals = busyCalendars(await listCals(token), `${accountId}/${acc.email}`);
        const perCal = await Promise.all(
          cals.map(async (cal): Promise<PlanEvent[]> => {
            try {
              const evs = await listEvs(token, { calendarId: cal.id, timeMin, timeMax });
              const out: PlanEvent[] = [];
              for (const e of evs) {
                if (!eventBlocksBusy(e)) continue;
                const start = e.start?.dateTime ?? e.start?.date;
                if (!start) continue;
                out.push({
                  title: e.summary ?? "(sem título)",
                  start,
                  end: e.end?.dateTime ?? e.end?.date ?? null,
                  all_day: !!e.start?.date,
                  calendar: cal.summary ?? cal.id,
                });
              }
              return out;
            } catch (err: any) {
              console.warn(
                `[plan-context] ${accountId}: calendar ${cal.id} failed: ${err?.message ?? err}`,
              );
              return [];
            }
          }),
        );
        for (const list of perCal) events.push(...list);
      } catch (err: any) {
        console.warn(`[plan-context] ${accountId}: Google ${acc.email} failed: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    console.warn(`[plan-context] ${accountId}: Google lookup failed: ${err?.message ?? err}`);
  }

  // --- brain union (ALWAYS): iCal-indexed events cover calendars/accounts the
  // Google OAuth path doesn't see; dedupPlanEvents drops the overlap (live
  // events are pushed first, so they win). SQL window over-fetches ±1 day —
  // the stored offset may differ from the user's tz; the pure mapper re-cuts
  // by LOCAL date.
  try {
    const queryRows = deps.queryBrainRows ?? defaultQueryBrainRows;
    const rows = await queryRows(accountId, shiftDate(periodStart, -1), shiftDate(periodEnd, 1));
    events.push(...brainRowsToPlanEvents(rows, periodStart, periodEnd, tz));
  } catch (err: any) {
    console.warn(`[plan-context] ${accountId}: brain calendar union failed: ${err?.message ?? err}`);
  }

  return events;
}
