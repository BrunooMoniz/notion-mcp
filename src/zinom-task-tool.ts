// src/zinom-task-tool.ts
// WS2 — the friend-facing "act in Notion" tool. Lets the user's AI create a
// task / event / reminder in their Notion (the "Tarefas" tracker), with an
// optional date — delivering the "o Zinom agenda por você" promise WITHOUT
// exposing the full destructive Notion CRUD surface to non-technical friends.
//
// Account-scoped by construction: the account comes from getAccountId() (the
// trusted request context), never from tool input. Registered ONLY for friend
// accounts (see index.ts); the owner ('bruno') uses the full notion_* suite.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccountId } from "./context.js";
import { createTaskPage, NoNotionError } from "./portal/task-write.js";

export function registerZinomTaskTool(server: McpServer): void {
  server.tool(
    "zinom_create_task",
    `Cria uma tarefa, evento, compromisso ou lembrete no Notion da pessoa (na base "Tarefas" do Zinom), com data opcional.

Use SEMPRE que a pessoa pedir para "criar uma tarefa", "agendar", "marcar", "criar um evento", "me lembrar de", "anotar pra fazer", etc. O Zinom age pela pessoa criando a página no Notion dela. Se ela ainda não tiver uma base de Tarefas, o Zinom cria automaticamente na primeira vez.

Parâmetros:
- titulo: o nome da tarefa/evento (obrigatório).
- data: data ou data-hora em ISO 8601 (ex.: "2026-06-09" para o dia, ou "2026-06-09T20:00:00-03:00" para 20h). Calcule a data absoluta a partir de expressões como "hoje", "amanhã", "sexta 20h" usando a data atual. Opcional.
- status: "A fazer" | "Fazendo" | "Feito" (opcional).
- nota: detalhe livre adicionado no corpo da página (opcional).

Responde em português confirmando o que foi criado, com o link da página.`,
    {
      titulo: z.string().min(1).describe("Nome da tarefa/evento"),
      data: z
        .string()
        .optional()
        .describe('Data/hora ISO 8601, ex.: "2026-06-09" ou "2026-06-09T20:00:00-03:00"'),
      status: z.string().optional().describe('Status, ex.: "A fazer"'),
      nota: z.string().optional().describe("Detalhe livre para o corpo da página"),
    },
    async ({ titulo, data, status, nota }) => {
      const accountId = getAccountId();
      try {
        const r = await createTaskPage(accountId, { title: titulo, date: data, status, note: nota });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                created: r.created, // true if the Tarefas base was created on first use
                titulo,
                data: data ?? null,
                url: r.url,
                message: r.created
                  ? "Criei sua base de Tarefas no Notion e adicionei este item."
                  : "Tarefa criada no seu Notion.",
              }),
            },
          ],
        };
      } catch (e: any) {
        const isNoNotion = e instanceof NoNotionError;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: isNoNotion ? "no_notion" : "create_failed",
                message: isNoNotion
                  ? "Você ainda não conectou um Notion. Abra o portal (zinom.ai) e conecte seu Notion para eu poder criar tarefas e eventos."
                  : `Não consegui criar a tarefa: ${e?.message ?? String(e)}`,
              }),
            },
          ],
        };
      }
    },
  );
}
