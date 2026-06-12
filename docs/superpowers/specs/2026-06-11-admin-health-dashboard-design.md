# Painel de Saúde do Sistema no Admin (estilo Grafana)

Data: 2026-06-11 · Status: aprovado para implementação · Branch: `feat/admin-health-dashboard`

## Contexto e objetivo

O admin (`/admin`) hoje cobre o negócio (receita, funil, engajamento, custo, contas), e o
`/status` cobre só a saúde das fontes de indexação. Não existe um lugar único que responda
"o sistema está saudável?": estado da VPS, dos processos PM2, do Postgres, das APIs de
parceiros (Notion, Anthropic, Voyage, Resend, Stripe) e do consumo/orçamento de IA.

Objetivo: uma seção **Sistema** dentro do `/admin`, primeira do menu, estilo Grafana
(tiles de status verde/amarelo/vermelho, gauges, sparklines de 24h, auto-refresh), com
histórico curto e alertas ntfy em transição de estado.

## Critério de aceite (verificado por máquina)

1. `npm run build` e `npm test` verdes, incluindo testes unitários novos de cada probe
   (fetch injetável + fixtures), do módulo de orçamento, do agregador e do sparkline SVG.
2. Spec Playwright (`tests/e2e/admin-ui.spec.ts` ou novo arquivo) renderiza o admin com
   fixture e afirma: seção `#sistema` existe, contém tiles com estados ok/warn/fail e as
   barras de orçamento.
3. Pós-deploy: `GET /admin?token=…` contém `id="sistema"`; `GET /admin/health.json`
   (Bearer) retorna JSON com `checks[]` e `overall`; `GET /health` 200;
   `https://zinom.ai/mcp` responde 401.

## Decisão de arquitetura e tradeoffs

**Escolhida: opção B — painel nativo no admin, collector interno + histórico no Postgres.**

- **A) Grafana + Prometheus reais na VPS.** Prós: padrão de mercado, gráficos ricos.
  Contras: dois serviços novos para operar numa VPS pequena, autenticação separada,
  superfície de ataque nova, não se integra ao admin existente. Pesado demais para um
  operador único. Rejeitada.
- **B) Seção nativa no admin (escolhida).** Collector com `node-cron` (dependência já
  existente) dentro do `notion-mcp`, amostras em tabela `health_samples`, renderização
  server-side no padrão do admin, sparklines em SVG puro, auto-refresh via
  `/admin/health.json`. Prós: zero infra nova, mesma auth, mesma identidade visual,
  testável no CI, alertas reusam `notify()` (ntfy). Contras: gráficos mais simples que
  Grafana (sparklines, não interativos). Aceito.
- **C) Serviço externo de uptime (healthchecks.io etc.).** Vê a VPS cair de fora, mas não
  cobre créditos nem métricas internas. Fica como complemento futuro, fora deste escopo.

**Limitação conhecida (explícita):** o painel roda na própria VPS. Se a VPS inteira cair,
o painel e os alertas caem junto. O check do proxy público e um watchdog externo (opção C)
são a mitigação futura; não tratar neste escopo.

**Sobre "crédito" das IAs:** Anthropic e Voyage **não expõem saldo de créditos por API**.
A Anthropic expõe o relatório de custo da organização (Admin API, já integrado em
`src/admin/anthropic-cost.ts`). O painel implementa "crédito" como **gasto medido no mês
vs. orçamento mensal configurado** (`HEALTH_BUDGET_*`), o que dá o mesmo sinal operacional
(quanto falta antes de estourar). Stripe tem endpoint de saldo real e será mostrado.

## Painéis da seção Sistema

1. **Visão geral** — tile grande com estado agregado (pior estado entre todos os checks),
   timestamp da última coleta e botão "Atualizar agora".
2. **VPS** — gauges de disco (%), memória (%), load (1/5/15 min vs nº de cores), uptime.
   Warn: disco >80%, mem >85%, load1 > cores. Fail: disco >92%, mem >95%.
3. **Processos PM2** — um chip por processo (`notion-mcp`, `brain-indexer`,
   `brain-classifier`, `brain-reindex-nightly`): status, restarts, memória.
4. **Postgres** — latência de `SELECT 1`, tamanho do banco, conexões ativas.
5. **Entrada pública** — `GET https://zinom.ai/mcp` deve responder **401** (prova a cadeia
   Cloudflare Worker → Tailscale Funnel → VPS). 404/timeout = fail.
6. **APIs de parceiros** — um tile por parceiro com status + latência + sparkline 24h:
   Notion (por workspace), Anthropic, Voyage, Resend, Stripe, ntfy.
7. **Créditos de IA** — barras de orçamento: gasto Anthropic no mês (Admin API, real) vs.
   `HEALTH_BUDGET_ANTHROPIC_USD`; custo estimado Voyage (embed_tokens do `usage_log` ×
   `COST_EMBED_PER_MTOK`) vs. `HEALTH_BUDGET_VOYAGE_USD`; tokens LLM in/out do mês.
   Warn ≥80%, fail ≥100%. Saldo Stripe (disponível/pendente) como card informativo.
8. **Fontes de indexação** — resumo compacto do `/status` (n saudáveis / stale / falhando)
   com link para a página completa.

## Inventário de checks

| check | como | credencial | custo | timeout |
|---|---|---|---|---|
| `vps` | `os.loadavg/uptime`, `/proc/meminfo` (fallback `os.freemem`), `fs.statfs('/')` | — | zero | local |
| `postgres` | `SELECT 1` + `pg_database_size` + `pg_stat_database.numbackends` | pool existente | zero | 5s |
| `pm2` | `pm2 jlist` via `execFile` (graceful skip se ausente, ex. dev) | — | zero | 5s |
| `proxy_publico` | `GET https://zinom.ai/mcp` sem auth, espera 401 | — | zero | 8s |
| `notion:<ws>` | `GET /v1/users/me` por workspace token | `NOTION_*_TOKEN` | zero | 8s |
| `anthropic` | `GET /v1/models` | `ANTHROPIC_API_KEY` | zero | 8s |
| `voyage` | `POST /v1/embeddings` input `"ping"` | `VOYAGE_API_KEY` | ~1 token (≈$0,0000002) | 8s |
| `resend` | `GET /domains` (401 `restricted_api_key` = ok: chave de envio válida) | `RESEND_API_KEY` | zero | 8s |
| `stripe` | `GET /v1/balance` | `STRIPE_SECRET_KEY` | zero | 8s |
| `ntfy` | `GET <raiz do NTFY_URL>/v1/health` (o tópico não aceita HEAD) | — | zero | 8s |
| `budget:anthropic` | `getOrgCostReport()` MTD vs env | `ANTHROPIC_ADMIN_KEY` | zero (cache 1h) | 10s |
| `budget:voyage` | `usage_log` embed_tokens MTD × custo vs env | pool | zero | 5s |

Checks sem credencial configurada retornam `skip` (cinza, "não configurado") — nunca
quebram a página nem o collector.

## Modelo de dados

Migration `00XX_health_samples.sql` (próximo número livre):

```sql
CREATE TABLE IF NOT EXISTS health_samples (
  id         bigserial PRIMARY KEY,
  check_id   text        NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),
  status     text        NOT NULL CHECK (status IN ('ok','warn','fail','skip')),
  latency_ms integer,
  detail     jsonb,
  error      text
);
CREATE INDEX IF NOT EXISTS idx_health_samples_check_ts ON health_samples (check_id, ts DESC);
```

Volume: ~20 checks × 288 coletas/dia × 7 dias ≈ 40k linhas. Prune de >7 dias a cada coleta.

## Collector

- Roda no processo `notion-mcp` (mesmo processo do `/admin`), `node-cron` com
  `HEALTH_CRON` (default `*/5 * * * *`). Roda uma coleta no boot (após 30s).
- Executa todos os probes em paralelo (`Promise.allSettled`), cada um com seu timeout
  (`AbortSignal.timeout`). Falha de um probe nunca derruba a coleta.
- Grava uma linha por check em `health_samples`; depois compara com o estado anterior e
  dispara alertas; depois faz o prune.
- `runHealthCollection()` é exportada e idempotente — usada pelo cron, pelo boot e pelo
  botão "Atualizar agora" (`POST /admin/health/run`), com lock simples em memória contra
  execução concorrente.

## Contrato de tipos (fixado antes do fan-out)

```ts
// src/health/types.ts
export type HealthStatus = "ok" | "warn" | "fail" | "skip";
export interface CheckResult {
  checkId: string;            // ex.: "notion:personal", "vps", "budget:anthropic"
  label: string;              // nome de exibição pt-BR
  group: "vps" | "processos" | "banco" | "entrada" | "parceiros" | "creditos";
  status: HealthStatus;
  latencyMs?: number;
  detail?: Record<string, unknown>;  // números p/ gauges (diskPct, memPct, spentUsd, budgetUsd…)
  error?: string;
}
export type Probe = () => Promise<CheckResult[]>;  // um probe pode emitir vários checks
```

## UI

- Nova seção `#sistema`, primeira no sidebar/tabbar e view default do admin.
- Mesma identidade do admin (tokens CSS existentes, tema claro). Tiles em grid CSS:
  ponto colorido (ok verde, warn âmbar `#c98a00`, fail vermelho, skip cinza), valor
  grande, latência e sparkline.
- Sparkline: função pura `renderSparkline(points, opts): string` (SVG inline, sem
  dependência nova), com teste unitário.
- Dados: `gather()` do admin passa a incluir o snapshot de saúde (última amostra por check
  + séries de 24h via uma query agregada). Render puro `renderSystemSection(data)` no
  padrão das outras seções.
- `GET /admin/health.json` (mesma gate do admin): `{ overall, collectedAt, checks: [...] }`.
  Script inline da seção faz fetch a cada 60s e atualiza valores/classes via `data-check`.
- `POST /admin/health/run`: roda a coleta agora e redireciona para `/admin#sistema` com
  banner (padrão dos outros POSTs do admin).

## Alertas (ntfy, reusa `src/notify.ts`)

- Transição `ok|warn → fail`: notifica prioridade `high` ("✗ <check> falhou: <erro>").
- Transição `fail → ok`: notifica recuperação, prioridade `default`.
- Orçamento cruzando 80% e 100%: no máximo 1 alerta por limiar por dia UTC (estado
  derivado das amostras já gravadas; reinício do processo pode re-alertar uma vez —
  aceito e documentado).
- `skip` nunca alerta.

## Segurança

- Mesma gate do admin (BEARER_TOKEN header ou `?token=`); nenhum endpoint novo sem gate.
- Nenhum valor de credencial aparece em HTML, JSON, logs ou `detail` — só nomes de envs e
  estados. Erros de parceiros são truncados (200 chars) antes de gravar.
- Probes externos nunca enviam dados do sistema para fora (só chamadas de leitura).

## Variáveis de ambiente novas (todas opcionais)

| env | default | efeito |
|---|---|---|
| `HEALTH_CRON` | `*/5 * * * *` | cadência da coleta; vazio/`off` desliga o collector |
| `HEALTH_PUBLIC_URL` | `https://zinom.ai/mcp` | URL do check de entrada pública |
| `HEALTH_BUDGET_ANTHROPIC_USD` | — | orçamento mensal Anthropic (sem ele, card mostra só o gasto) |
| `HEALTH_BUDGET_VOYAGE_USD` | — | orçamento mensal Voyage estimado |

## Fora de escopo (YAGNI)

- Grafana/Prometheus reais; watchdog externo; métricas por requisição (APM); retenção
  longa/downsampling; dashboards configuráveis; tema escuro; alertas por e-mail.

## Premissas registradas (sessão autônoma)

- Operador único (Bruno); auth atual do admin é suficiente.
- "Crédito de IA" = gasto medido vs. orçamento configurado (sem API de saldo nos
  provedores); validado com o gasto real Anthropic via Admin API.
- Granola e iCal não ganham probe direto: as chaves são por conta (vault) e a saúde
  já aparece via `status_runs` no painel de fontes.
