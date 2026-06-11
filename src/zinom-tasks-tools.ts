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

function taskError(e: unknown): ReturnType<typeof fail> {
  if (e instanceof NoNotionError) return fail("no_notion", NO_NOTION_MSG);
  if (e instanceof NoTrackerError) return fail("no_tracker", NO_TRACKER_MSG);
  if (e instanceof TaskNotFoundError) {
    return fail(
      "not_found",
      "Não encontrei essa tarefa na sua base (task_id inválido ou de outra base). Use zinom_list_tasks para pegar o id certo.",
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  return fail("task_failed", msg);
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
      tipo: z.enum(["fazer", "cobrar"]).optional().describe("fazer = eu executo; cobrar = cobrar de alguém"),
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
        return taskError(e);
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

Retorna {tasks, board, tracker_url}: tasks no modelo canônico (id, title, status, prioridade, prazo, tempo_estimado_min, tipo, quem, origem_url, projeto), board com contagem por status + minutos estimados dos abertos + overdue_count.`,
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
        return json({ ok: true, tasks: r.tasks, board: r.board, tracker_url: r.tracker_url });
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
- tempo_estimado_min, tipo (fazer|cobrar), quem, projeto.
- nota_append: parágrafo adicionado ao corpo da página (histórico/cobranças).`,
    {
      task_id: z.string().min(1).describe("Id da tarefa (de zinom_list_tasks)"),
      titulo: z.string().optional(),
      status: z.string().optional().describe("Canônico ou literal da base"),
      prioridade: z.string().optional().describe("urgente | alta | media | baixa"),
      prazo: z.string().optional().describe('ISO 8601; "" limpa o prazo'),
      prazo_fim: z.string().optional().describe("Fim do bloco (só com prazo)"),
      tempo_estimado_min: z.number().int().positive().optional(),
      tipo: z.enum(["fazer", "cobrar"]).optional(),
      quem: z.string().optional(),
      projeto: z.string().optional(),
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
    `Retorna TUDO que você precisa para planejar o dia/semana/mês da pessoa numa chamada só: agenda real (eventos ao vivo de todas as contas Google conectadas, com fallback nos eventos indexados no cérebro), janelas livres por dia, e o board de tarefas abertas agrupado por status.

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
        const todayISO = new Date().toISOString().slice(0, 10);
        let tasksSection: ReturnType<typeof groupOpenTasks> = { by_status: {}, overdue: [] };
        let abertos = 0;
        let estimado_min = 0;
        let tracker_note: string | null = null;
        try {
          const r = await listTasks(accountId, { limit: 100 });
          tasksSection = groupOpenTasks(r.tasks, todayISO);
          abertos = r.board.abertos;
          estimado_min = r.board.estimado_min;
        } catch (e) {
          if (e instanceof NoTrackerError || e instanceof NoNotionError) {
            tracker_note = NO_TRACKER_MSG;
          } else {
            throw e;
          }
        }

        const free_min = free_slots.reduce((acc, d) => acc + d.free_min, 0);
        return json({
          ok: true,
          period: { start: period_start, end: period_end, timezone: tz },
          events,
          free_slots,
          tasks: tasksSection.by_status,
          overdue: tasksSection.overdue,
          totals: { free_min, abertos, estimado_min, overdue: tasksSection.overdue.length },
          ...(tracker_note ? { tracker_note } : {}),
          guidance: PLAN_GUIDANCE,
        });
      } catch (e) {
        return taskError(e);
      }
    },
  );
}

// --- event gathering (live Google → brain-indexed fallback) -----------------------

async function gatherEvents(
  accountId: string,
  periodStart: string,
  periodEnd: string,
  tz: string,
): Promise<PlanEvent[]> {
  const events: PlanEvent[] = [];
  let googleOk = false;

  try {
    const { getGoogleAccounts } = await import("./google/google-accounts.js");
    const { getGoogleAccessTokenFor } = await import("./google/google-token.js");
    const { listCalendarsWithToken, listEventsWithToken } = await import("./google/calendar.js");

    const timeMin = zonedTimeToUtc(periodStart, "00:00", tz).toISOString();
    // End of the last day = start of the following day in the local timezone.
    const dayAfter = new Date(new Date(`${periodEnd}T00:00:00Z`).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const timeMax = zonedTimeToUtc(dayAfter, "00:00", tz).toISOString();

    for (const acc of await getGoogleAccounts(accountId)) {
      try {
        const token = await getGoogleAccessTokenFor(accountId, acc.email);
        for (const cal of await listCalendarsWithToken(token)) {
          const evs = await listEventsWithToken(token, { calendarId: cal.id, timeMin, timeMax });
          for (const e of evs) {
            if (e.status === "cancelled") continue;
            const start = e.start?.dateTime ?? e.start?.date;
            if (!start) continue;
            events.push({
              title: e.summary ?? "(sem título)",
              start,
              end: e.end?.dateTime ?? e.end?.date ?? null,
              all_day: !!e.start?.date,
              calendar: cal.summary ?? cal.id,
            });
          }
          googleOk = true;
        }
      } catch (err: any) {
        console.warn(`[plan-context] ${accountId}: Google ${acc.email} failed: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    console.warn(`[plan-context] ${accountId}: Google lookup failed: ${err?.message ?? err}`);
  }

  // Fallback/union: brain-indexed calendar chunks (iCal feeds) cover accounts
  // without Google OAuth (e.g. the owner's GOOGLE_CAL_ICS pipeline).
  if (!googleOk || events.length === 0) {
    try {
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
        [accountId, periodStart, periodEnd],
      );
      for (const r of rows as Array<{ text?: string; data: string | null; calendar_label: string | null }>) {
        if (!r.data) continue;
        const firstLine = (r.text ?? "").split("\n")[0] ?? "";
        events.push({
          title: firstLine.replace(/^#\s+/, "").trim() || "(sem título)",
          start: r.data,
          end: null,
          all_day: !/T/.test(r.data),
          calendar: r.calendar_label ?? "",
        });
      }
    } catch (err: any) {
      console.warn(`[plan-context] ${accountId}: brain fallback failed: ${err?.message ?? err}`);
    }
  }

  return events;
}
