# Google Calendar multi-conta (ler + criar/editar/excluir) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada conta (dono e amigos) conecta N contas Google próprias via OAuth pelo portal e ganha tools MCP para listar agendas/eventos e criar, editar e excluir eventos, tudo isolado por `account_id`.

**Architecture:** Estende o OAuth Google existente (`src/google/`) para multi-conta guardando refresh tokens no vault criptografado por conta (`account_secrets`, kind `google_oauth`), espelhando o padrão de iCal (`src/portal/sources.ts`) e de token por conta (`src/account-tokens.ts`). Conexão pelo portal (sessão → `state` → callback grava no vault da conta). Builders puros para o payload do evento (espelhando `buildTaskPagePayload`). 5 tools MCP finas que leem `getAccountId()` e validam o `calendar_ref` contra as contas conectadas daquela conta.

**Tech Stack:** TypeScript (NodeNext, imports com `.js`), Express, `@modelcontextprotocol/sdk`, Node `crypto`, Postgres (vault), `node:test` + `node:assert/strict` (runner `tsx --test`), Google Calendar API v3.

**Repo/base:** clone `.context/notion-mcp`, branch novo a partir de `origin/main`. Sem migração de banco (reusa `account_secrets`).

**Spec:** `docs/superpowers/specs/2026-06-07-google-calendar-multi-account-design.md`.

---

## File Structure

Novos (todos em `.context/notion-mcp/`):
- `src/google/calendar-ref.ts` — encode/decode opaco `email`+`calendarId` (puro).
- `src/google/event-payload.ts` — builders puros do corpo de criar/editar evento.
- `src/google/google-accounts.ts` — store de contas Google no vault (array, kind `google_oauth`).
- `src/google/google-token.ts` — resolver de access token por (conta, email) + `resolveCalendarRef` com guarda de isolamento.
- `src/google/calendar-tool.ts` — `registerCalendarTools(server)` com as 5 tools.
- `src/portal/google-link.ts` — mapa de `state` OAuth → accountId do portal (espelha `notion-link.ts`).
- `src/google/__tests__/*.test.ts` — testes.

Modificados:
- `src/google/oauth.ts` — escopos (readonly+events), `exchangeCodeRaw`, `refreshAccessToken`.
- `src/google/calendar.ts` — `calGet` aceita token; `calSend`; wrappers com token + create/update/delete.
- `src/google/routes.ts` — callback trata o fluxo do portal (grava no vault).
- `src/portal/routes.ts` — rotas `/portal/google/{connect,accounts,disconnect}`.
- `src/index.ts` — registra as tools no ramo owner e amigo.
- `src/mcp-account-config.ts` — `FRIEND_INSTRUCTIONS` cita as tools de calendário.
- `package.json` — glob de teste inclui `src/google/__tests__/*.test.ts`.
- `portal/app.html` + `portal/app.js` — seção "Google Calendar".
- `README.md` / `docs/RUNBOOK.md` — passos do Google Cloud + nota operacional.

---

### Task 0: Branch + glob de teste

**Files:**
- Modify: `package.json:14`

- [ ] **Step 1: Criar o branch a partir de origin/main**

Run:
```bash
cd /Users/bruno.moniz/conductor/workspaces/mcp-notion/miami/.context/notion-mcp
git fetch origin main
git checkout -b feat/google-calendar-multi-account origin/main
```
Expected: branch novo, working tree limpo.

- [ ] **Step 2: Incluir o diretório de testes google no `npm test`**

Em `package.json`, trocar a linha do script `test` por:
```json
    "test": "tsx --test src/rag/__tests__/*.test.ts src/portal/__tests__/*.test.ts src/billing/__tests__/*.test.ts src/google/__tests__/*.test.ts",
```

- [ ] **Step 3: Verificar que a suíte atual continua verde (baseline)**

Run: `npm test`
Expected: PASS (sem testes google ainda; glob com zero matches em `src/google/__tests__` não quebra).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(test): include src/google/__tests__ in test glob"
```

---

### Task 1: `calendar-ref.ts` (referência opaca de agenda, pura)

**Files:**
- Create: `src/google/calendar-ref.ts`
- Test: `src/google/__tests__/calendar-ref.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/calendar-ref.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCalendarRef, decodeCalendarRef } from "../calendar-ref.js";

test("round-trip de email + calendarId", () => {
  const ref = encodeCalendarRef("bruno@gmail.com", "abc@group.calendar.google.com");
  assert.deepEqual(decodeCalendarRef(ref), {
    email: "bruno@gmail.com",
    calendarId: "abc@group.calendar.google.com",
  });
});

test("ref opaco não é o texto cru (base64url)", () => {
  const ref = encodeCalendarRef("a@b.com", "primary");
  assert.ok(!ref.includes("@"));
  assert.match(ref, /^[A-Za-z0-9_-]+$/);
});

test("ref malformado lança", () => {
  assert.throws(() => decodeCalendarRef("não-base64-válido!!!"));
  assert.throws(() => decodeCalendarRef(Buffer.from('{"x":1}', "utf8").toString("base64url")));
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/calendar-ref.test.ts`
Expected: FAIL ("Cannot find module ../calendar-ref.js").

- [ ] **Step 3: Implementar**

```ts
// src/google/calendar-ref.ts
// Referência opaca de agenda para as tools: embute (email da conta Google,
// calendarId) num único token base64url, para criar/editar/excluir sem
// ambiguidade entre contas. NÃO é segredo (é só um id); o isolamento real é
// feito em google-token.ts validando o email contra as contas conectadas.

export function encodeCalendarRef(email: string, calendarId: string): string {
  return Buffer.from(JSON.stringify([email, calendarId]), "utf8").toString("base64url");
}

export function decodeCalendarRef(ref: string): { email: string; calendarId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
  } catch {
    throw new Error("calendar_ref inválido");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error("calendar_ref inválido");
  }
  return { email: parsed[0], calendarId: parsed[1] };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/calendar-ref.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/calendar-ref.ts src/google/__tests__/calendar-ref.test.ts
git commit -m "feat(google): calendar_ref opaco (email+calendarId)"
```

---

### Task 2: `event-payload.ts` (builders puros do evento)

**Files:**
- Create: `src/google/event-payload.ts`
- Test: `src/google/__tests__/event-payload.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/event-payload.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEventPayload, buildEventPatch } from "../event-payload.js";

test("evento com horário (dateTime), sem timezone", () => {
  const b = buildEventPayload({
    summary: "Call Victor",
    start: "2026-06-09T15:00:00-03:00",
    end: "2026-06-09T16:00:00-03:00",
  }) as any;
  assert.equal(b.summary, "Call Victor");
  assert.deepEqual(b.start, { dateTime: "2026-06-09T15:00:00-03:00" });
  assert.deepEqual(b.end, { dateTime: "2026-06-09T16:00:00-03:00" });
});

test("evento com timezone explícito", () => {
  const b = buildEventPayload({
    summary: "X",
    start: "2026-06-09T15:00:00",
    end: "2026-06-09T16:00:00",
    timezone: "America/Sao_Paulo",
  }) as any;
  assert.deepEqual(b.start, { dateTime: "2026-06-09T15:00:00", timeZone: "America/Sao_Paulo" });
});

test("evento de dia inteiro (date)", () => {
  const b = buildEventPayload({ summary: "Feriado", start: "2026-06-09", end: "2026-06-10", all_day: true }) as any;
  assert.deepEqual(b.start, { date: "2026-06-09" });
  assert.deepEqual(b.end, { date: "2026-06-10" });
});

test("descrição, local e convidados", () => {
  const b = buildEventPayload({
    summary: "X",
    start: "2026-06-09T15:00:00",
    end: "2026-06-09T16:00:00",
    description: "pauta",
    location: "Meet",
    attendees: ["a@x.com", "b@y.com"],
  }) as any;
  assert.equal(b.description, "pauta");
  assert.equal(b.location, "Meet");
  assert.deepEqual(b.attendees, [{ email: "a@x.com" }, { email: "b@y.com" }]);
});

test("patch só inclui campos passados", () => {
  const p = buildEventPatch({ summary: "Novo título" }) as any;
  assert.deepEqual(p, { summary: "Novo título" });
  const p2 = buildEventPatch({ start: "2026-06-09T18:00:00", timezone: "America/Sao_Paulo" }) as any;
  assert.deepEqual(p2.start, { dateTime: "2026-06-09T18:00:00", timeZone: "America/Sao_Paulo" });
  assert.equal(p2.summary, undefined);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/event-payload.test.ts`
Expected: FAIL ("Cannot find module ../event-payload.js").

- [ ] **Step 3: Implementar**

```ts
// src/google/event-payload.ts
// Builders puros do corpo de evento da Google Calendar API v3. Sem rede, sem
// estado — testáveis isolados (espelha buildTaskPagePayload). Datas vêm prontas
// em ISO 8601 (a tool instrui a IA a calcular a data absoluta).

export interface CreateEventInput {
  summary: string;
  start: string; // ISO datetime, ou YYYY-MM-DD se all_day
  end: string;
  description?: string;
  location?: string;
  attendees?: string[]; // emails
  timezone?: string; // IANA, ex.: America/Sao_Paulo
  all_day?: boolean;
}

function timePoint(value: string, allDay: boolean | undefined, tz: string | undefined) {
  if (allDay) return { date: value };
  return tz ? { dateTime: value, timeZone: tz } : { dateTime: value };
}

export function buildEventPayload(input: CreateEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = { summary: input.summary };
  if (input.description) body.description = input.description;
  if (input.location) body.location = input.location;
  if (input.attendees && input.attendees.length) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  body.start = timePoint(input.start, input.all_day, input.timezone);
  body.end = timePoint(input.end, input.all_day, input.timezone);
  return body;
}

export interface UpdateEventInput {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timezone?: string;
  all_day?: boolean;
}

export function buildEventPatch(input: UpdateEventInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.attendees !== undefined) patch.attendees = input.attendees.map((email) => ({ email }));
  if (input.start !== undefined) patch.start = timePoint(input.start, input.all_day, input.timezone);
  if (input.end !== undefined) patch.end = timePoint(input.end, input.all_day, input.timezone);
  return patch;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/event-payload.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/event-payload.ts src/google/__tests__/event-payload.test.ts
git commit -m "feat(google): builders puros do payload de evento (create/patch)"
```

---

### Task 3: `google-accounts.ts` (store de contas Google no vault)

**Files:**
- Create: `src/google/google-accounts.ts`
- Test: `src/google/__tests__/google-accounts.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/google-accounts.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64); // vault precisa de chave antes do import

import {
  addGoogleAccount,
  getGoogleAccounts,
  removeGoogleAccount,
  getRefreshToken,
  listGoogleAccountsMasked,
} from "../google-accounts.js";
import { __setPoolForTest } from "../../rag/storage.js";

let store: Map<string, string>; // `${account}|${kind}` -> enc_value

function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) {
        store.set(`${params[0]}|${params[1]}`, params[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) {
        const v = store.get(`${params[0]}|${params[1]}`);
        return { rows: v ? [{ enc_value: v }] : [] };
      }
      if (/DELETE FROM account_secrets/i.test(sql)) {
        store.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  store = new Map();
  __setPoolForTest(memPool() as never);
});
afterEach(() => __setPoolForTest(null));

test("adiciona duas contas Google; upsert por email (sem duplicar)", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r-a", scopes: ["s"], connected_at: "2026-06-07T00:00:00Z" });
  await addGoogleAccount("acc:1", { email: "b@gmail.com", refresh_token: "r-b", scopes: ["s"], connected_at: "2026-06-07T00:00:00Z" });
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r-a2", scopes: ["s"], connected_at: "2026-06-07T01:00:00Z" }); // reconecta a mesma

  const accounts = await getGoogleAccounts("acc:1");
  assert.equal(accounts.length, 2);
  assert.equal(await getRefreshToken("acc:1", "a@gmail.com"), "r-a2"); // atualizado
});

test("lista mascarada não vaza refresh_token; texto cifrado em repouso", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "super-refresh-xyz", scopes: ["s"] });
  const masked = await listGoogleAccountsMasked("acc:1");
  assert.deepEqual(masked.map((m) => m.email), ["a@gmail.com"]);
  assert.ok(!JSON.stringify(masked).includes("super-refresh-xyz"));

  const enc = store.get("acc:1|google_oauth")!;
  assert.match(enc, /^v1:/); // envelope AES-GCM
  assert.ok(!enc.includes("super-refresh-xyz"));
});

test("isolamento: conta B não vê refresh_token da conta A", async () => {
  await addGoogleAccount("acc:A", { email: "x@gmail.com", refresh_token: "rA", scopes: [] });
  assert.equal(await getRefreshToken("acc:B", "x@gmail.com"), null);
});

test("remover a última conta apaga o segredo", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r", scopes: [] });
  assert.equal(await removeGoogleAccount("acc:1", "a@gmail.com"), true);
  assert.equal((await getGoogleAccounts("acc:1")).length, 0);
  assert.ok(!store.has("acc:1|google_oauth"));
  assert.equal(await removeGoogleAccount("acc:1", "a@gmail.com"), false); // já não existe
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/google-accounts.test.ts`
Expected: FAIL ("Cannot find module ../google-accounts.js").

- [ ] **Step 3: Implementar**

```ts
// src/google/google-accounts.ts
// Contas Google OAuth de um account (tenant), guardadas como um array JSON no
// vault criptografado (account_secrets, kind "google_oauth"), espelhando o
// padrão de iCal (src/portal/sources.ts). refresh_token NUNCA é retornado por
// rota/tool — só getRefreshToken (uso interno) e o resolver de token o tocam.
import { setAccountSecret, getAccountSecret, deleteAccountSecret } from "../secrets.js";

const GOOGLE_KIND = "google_oauth";

export interface GoogleAccountEntry {
  email: string;
  refresh_token: string;
  scopes: string[];
  connected_at: string; // ISO
}

export interface GoogleAccountMasked {
  email: string;
  connected_at: string;
}

export async function getGoogleAccounts(accountId: string): Promise<GoogleAccountEntry[]> {
  const raw = await getAccountSecret(accountId, GOOGLE_KIND);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as GoogleAccountEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveGoogleAccounts(accountId: string, entries: GoogleAccountEntry[]): Promise<void> {
  if (entries.length === 0) {
    await deleteAccountSecret(accountId, GOOGLE_KIND);
    return;
  }
  await setAccountSecret(accountId, GOOGLE_KIND, JSON.stringify(entries));
}

/** Conecta (ou reconecta) uma conta Google; upsert por email. */
export async function addGoogleAccount(
  accountId: string,
  creds: { email: string; refresh_token: string; scopes: string[]; connected_at?: string },
): Promise<void> {
  const entries = await getGoogleAccounts(accountId);
  const entry: GoogleAccountEntry = {
    email: creds.email,
    refresh_token: creds.refresh_token,
    scopes: creds.scopes,
    connected_at: creds.connected_at ?? new Date().toISOString(),
  };
  const idx = entries.findIndex((e) => e.email === creds.email);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  await saveGoogleAccounts(accountId, entries);
}

/** Remove uma conta Google por email. Retorna false se não existia. */
export async function removeGoogleAccount(accountId: string, email: string): Promise<boolean> {
  const entries = await getGoogleAccounts(accountId);
  const next = entries.filter((e) => e.email !== email);
  if (next.length === entries.length) return false;
  await saveGoogleAccounts(accountId, next);
  return true;
}

/** Uso interno do resolver de token. null se a conta/email não está conectada. */
export async function getRefreshToken(accountId: string, email: string): Promise<string | null> {
  const e = (await getGoogleAccounts(accountId)).find((x) => x.email === email);
  return e?.refresh_token ?? null;
}

/** Inventário para exibir no portal (sem refresh_token). */
export async function listGoogleAccountsMasked(accountId: string): Promise<GoogleAccountMasked[]> {
  return (await getGoogleAccounts(accountId)).map((e) => ({
    email: e.email,
    connected_at: e.connected_at,
  }));
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/google-accounts.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/google-accounts.ts src/google/__tests__/google-accounts.test.ts
git commit -m "feat(google): store de contas Google no vault (multi-conta por tenant)"
```

---

### Task 4: `oauth.ts` — escopos de escrita + `exchangeCodeRaw` + `refreshAccessToken`

**Files:**
- Modify: `src/google/oauth.ts:13` (escopo), `src/google/oauth.ts:86-127` (exchange), `src/google/oauth.ts:129-158` (refresh)
- Test: `src/google/__tests__/oauth.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/oauth.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { authUrl, SCOPES, exchangeCodeRaw, refreshAccessToken } from "../oauth.js";

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("SCOPES inclui readonly e events; authUrl carrega ambos", () => {
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.readonly"));
  assert.ok(SCOPES.includes("https://www.googleapis.com/auth/calendar.events"));
  const scope = new URL(authUrl("st8")).searchParams.get("scope") ?? "";
  assert.ok(scope.includes("calendar.readonly"));
  assert.ok(scope.includes("calendar.events"));
});

test("exchangeCodeRaw troca o code e retorna creds (sem salvar em disco)", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("oauth2.googleapis.com/token")) {
      assert.match(String(init.body), /grant_type=authorization_code/);
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt" }), { status: 200 });
    }
    if (u.includes("userinfo")) {
      return new Response(JSON.stringify({ email: "bruno@gmail.com" }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  }) as typeof fetch;

  const creds = await exchangeCodeRaw("the-code");
  assert.equal(creds.refresh_token, "rt");
  assert.equal(creds.granted_email, "bruno@gmail.com");
  assert.ok(calls.some((c) => c.includes("token")));
});

test("refreshAccessToken posta grant_type=refresh_token e retorna o token", async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.match(String(init.body), /grant_type=refresh_token/);
    assert.match(String(init.body), /rt-123/);
    return new Response(JSON.stringify({ access_token: "new-at", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;

  const r = await refreshAccessToken("rt-123");
  assert.equal(r.access_token, "new-at");
  assert.equal(r.expires_in, 3600);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/oauth.test.ts`
Expected: FAIL (`SCOPES`/`exchangeCodeRaw`/`refreshAccessToken` não exportados).

- [ ] **Step 3: Editar `oauth.ts`**

3a. Trocar a linha 13 (`const SCOPE = ...`) por:
```ts
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];
const SCOPE = SCOPES.join(" ");
```

3b. Substituir a função `exchangeCode` (linhas 86-127) por este par (extrai `exchangeCodeRaw` sem salvar; mantém `exchangeCode` salvando no arquivo legado):
```ts
export async function exchangeCodeRaw(code: string): Promise<GoogleCreds> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json()) as TokenResp & { error?: string; error_description?: string };
  if (!resp.ok || data.error || !data.refresh_token) {
    throw new Error(
      `Google token exchange failed: ${data.error ?? "no_refresh_token"} ${data.error_description ?? ""}`,
    );
  }
  let granted_email: string | undefined;
  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (me.ok) {
      const u = (await me.json()) as { email?: string };
      granted_email = u.email;
    }
  } catch {
    /* ignore */
  }
  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    access_token_expires_at: Date.now() + (data.expires_in - 60) * 1000,
    granted_at: Date.now(),
    granted_email,
  };
}

export async function exchangeCode(code: string): Promise<GoogleCreds> {
  const creds = await exchangeCodeRaw(code);
  saveCreds(creds);
  return creds;
}
```

3c. Adicionar `refreshAccessToken` e refatorar `getAccessToken` para reusá-la. Substituir a função `getAccessToken` (linhas 129-158) por:
```ts
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google refresh failed: ${data.error ?? "unknown"}`);
  }
  return { access_token: data.access_token, expires_in: data.expires_in ?? 3600 };
}

export async function getAccessToken(): Promise<string> {
  const creds = loadCreds();
  if (!creds) throw new Error("Google not connected — visit /google/connect first");
  if (creds.access_token && creds.access_token_expires_at && creds.access_token_expires_at > Date.now()) {
    return creds.access_token;
  }
  const { access_token, expires_in } = await refreshAccessToken(creds.refresh_token);
  saveCreds({ ...creds, access_token, access_token_expires_at: Date.now() + (expires_in - 60) * 1000 });
  return access_token;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/oauth.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/oauth.ts src/google/__tests__/oauth.test.ts
git commit -m "feat(google): escopo calendar.events + exchangeCodeRaw + refreshAccessToken"
```

---

### Task 5: `google-token.ts` — resolver de token por conta + isolamento

**Files:**
- Create: `src/google/google-token.ts`
- Test: `src/google/__tests__/google-token.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/google-token.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SECRETS_KEY = "0".repeat(64);
process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";

import { getGoogleAccessTokenFor, resolveCalendarRef, __clearGoogleTokenCache } from "../google-token.js";
import { addGoogleAccount } from "../google-accounts.js";
import { encodeCalendarRef } from "../calendar-ref.js";
import { __setPoolForTest } from "../../rag/storage.js";

let store: Map<string, string>;
function memPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/INSERT INTO account_secrets/i.test(sql)) { store.set(`${params[0]}|${params[1]}`, params[2]); return { rows: [], rowCount: 1 }; }
      if (/SELECT enc_value FROM account_secrets/i.test(sql)) { const v = store.get(`${params[0]}|${params[1]}`); return { rows: v ? [{ enc_value: v }] : [] }; }
      if (/DELETE FROM account_secrets/i.test(sql)) { store.delete(`${params[0]}|${params[1]}`); return { rows: [], rowCount: 1 }; }
      return { rows: [] };
    },
  };
}

const realFetch = globalThis.fetch;
let refreshCalls = 0;
beforeEach(() => {
  store = new Map();
  refreshCalls = 0;
  __setPoolForTest(memPool() as never);
  __clearGoogleTokenCache();
  globalThis.fetch = (async () => {
    refreshCalls++;
    return new Response(JSON.stringify({ access_token: "at-" + refreshCalls, expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  __setPoolForTest(null);
  globalThis.fetch = realFetch;
});

test("refresh + cache: segunda chamada não bate na rede de novo", async () => {
  await addGoogleAccount("acc:1", { email: "a@gmail.com", refresh_token: "r", scopes: [] });
  const t1 = await getGoogleAccessTokenFor("acc:1", "a@gmail.com");
  const t2 = await getGoogleAccessTokenFor("acc:1", "a@gmail.com");
  assert.equal(t1, "at-1");
  assert.equal(t2, "at-1"); // veio do cache
  assert.equal(refreshCalls, 1);
});

test("conta inexistente erra claro", async () => {
  await assert.rejects(() => getGoogleAccessTokenFor("acc:1", "nao@existe.com"), /não conectada/);
});

test("isolamento: conta B não resolve um ref de agenda da conta A", async () => {
  await addGoogleAccount("acc:A", { email: "x@gmail.com", refresh_token: "rA", scopes: [] });
  const ref = encodeCalendarRef("x@gmail.com", "primary");
  await assert.rejects(() => resolveCalendarRef("acc:B", ref), /não pertence/);
  // a própria conta A resolve normalmente:
  const r = await resolveCalendarRef("acc:A", ref);
  assert.equal(r.email, "x@gmail.com");
  assert.equal(r.calendarId, "primary");
  assert.equal(r.token, "at-1");
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/google-token.test.ts`
Expected: FAIL ("Cannot find module ../google-token.js").

- [ ] **Step 3: Implementar**

```ts
// src/google/google-token.ts
// Resolve um access_token Google para um par (account, email): lê o refresh_token
// do vault daquele account, faz refresh sob demanda e cacheia em memória até
// expirar (espelha account-tokens.ts). resolveCalendarRef faz a GUARDA DE
// ISOLAMENTO: um calendar_ref só é aceito se seu email pertence a uma conta
// Google conectada por ESTE account — outro tenant não alcança a agenda.
import { getRefreshToken, getGoogleAccounts } from "./google-accounts.js";
import { refreshAccessToken } from "./oauth.js";
import { decodeCalendarRef } from "./calendar-ref.js";

interface Cached {
  token: string;
  expiresAt: number; // unix ms
}
const cache = new Map<string, Cached>(); // `${accountId}:${email}` -> token

/** Test seam: limpa o cache de tokens. */
export function __clearGoogleTokenCache(): void {
  cache.clear();
}

export async function getGoogleAccessTokenFor(accountId: string, email: string): Promise<string> {
  const key = `${accountId}:${email}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const refresh = await getRefreshToken(accountId, email);
  if (!refresh) {
    throw new Error(`Conta Google "${email}" não conectada nesta conta. Conecte no portal primeiro.`);
  }
  const { access_token, expires_in } = await refreshAccessToken(refresh);
  cache.set(key, { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 });
  return access_token;
}

export async function resolveCalendarRef(
  accountId: string,
  ref: string,
): Promise<{ email: string; calendarId: string; token: string }> {
  const { email, calendarId } = decodeCalendarRef(ref);
  const accounts = await getGoogleAccounts(accountId);
  if (!accounts.some((a) => a.email === email)) {
    throw new Error("Essa agenda não pertence a uma conta Google conectada nesta conta.");
  }
  const token = await getGoogleAccessTokenFor(accountId, email);
  return { email, calendarId, token };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/google-token.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/google-token.ts src/google/__tests__/google-token.test.ts
git commit -m "feat(google): resolver de token por conta + guarda de isolamento no calendar_ref"
```

---

### Task 6: `calendar.ts` — token explícito + escrita (create/update/delete)

**Files:**
- Modify: `src/google/calendar.ts:9-24` (`calGet` aceita token), e adiciona helpers de escrita ao fim do arquivo.
- Test: `src/google/__tests__/calendar-client.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/calendar-client.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createEvent, updateEvent, deleteEvent, listCalendarsWithToken } from "../calendar.js";

const realFetch = globalThis.fetch;
let last: { url: string; init: any };
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  last = { url: "", init: {} };
  globalThis.fetch = (async (url: any, init: any) => {
    last = { url: String(url), init };
    if (init?.method === "DELETE") return new Response("", { status: 204 });
    if (String(url).includes("calendarList")) return new Response(JSON.stringify({ items: [{ id: "primary", primary: true }] }), { status: 200 });
    return new Response(JSON.stringify({ id: "evt-1", htmlLink: "https://cal/evt-1" }), { status: 200 });
  }) as typeof fetch;
});

test("createEvent: POST para /calendars/{id}/events com Bearer e JSON", async () => {
  const ev = await createEvent("tok", "a@b.com", { summary: "X" });
  assert.equal(ev.id, "evt-1");
  assert.match(last.url, /\/calendars\/a%40b\.com\/events$/);
  assert.equal(last.init.method, "POST");
  assert.equal(last.init.headers.Authorization, "Bearer tok");
  assert.match(last.init.headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(last.init.body), { summary: "X" });
});

test("updateEvent: PATCH para /events/{eventId}", async () => {
  await updateEvent("tok", "primary", "evt-9", { summary: "Novo" });
  assert.match(last.url, /\/calendars\/primary\/events\/evt-9$/);
  assert.equal(last.init.method, "PATCH");
  assert.deepEqual(JSON.parse(last.init.body), { summary: "Novo" });
});

test("deleteEvent: DELETE para /events/{eventId}", async () => {
  await deleteEvent("tok", "primary", "evt-9");
  assert.match(last.url, /\/calendars\/primary\/events\/evt-9$/);
  assert.equal(last.init.method, "DELETE");
});

test("listCalendarsWithToken usa o token passado", async () => {
  const cals = await listCalendarsWithToken("tok");
  assert.equal(cals[0].id, "primary");
  assert.equal(last.init.headers.Authorization, "Bearer tok");
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/calendar-client.test.ts`
Expected: FAIL (`createEvent`/`updateEvent`/`deleteEvent`/`listCalendarsWithToken` não exportados).

- [ ] **Step 3: Editar `calendar.ts`**

3a. Trocar a assinatura de `calGet` (linha 9) para aceitar token opcional. Substituir as linhas 9-10:
```ts
async function calGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
  token?: string,
): Promise<T> {
  const t = token ?? (await getAccessToken());
```
E na linha do `fetch` dentro de `calGet`, trocar `Bearer ${token}` por `Bearer ${t}` (o header passa a usar `t`).

3b. Adicionar ao fim do arquivo (depois de `iterEvents`):
```ts
// --- Escrita + leitura com token explícito (multi-conta) --------------------

async function calSend<T>(
  token: string,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | null> {
  const resp = await fetch(`${CAL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const e = new Error(`Google Calendar ${resp.status}: ${text.slice(0, 300)}`);
    (e as any).status = resp.status;
    throw e;
  }
  return text ? (JSON.parse(text) as T) : null;
}

export async function listCalendarsWithToken(token: string): Promise<CalendarListEntry[]> {
  const resp = await calGet<{ items?: CalendarListEntry[] }>(
    "/users/me/calendarList",
    { minAccessRole: "reader", maxResults: 250 },
    token,
  );
  return resp.items ?? [];
}

export async function listEventsWithToken(
  token: string,
  opts: { calendarId: string; timeMin: string; timeMax: string; pageSize?: number },
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined = undefined;
  for (;;) {
    const resp: EventsResp = await calGet<EventsResp>(
      `/calendars/${encodeURIComponent(opts.calendarId)}/events`,
      {
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: opts.pageSize ?? 250,
        pageToken,
      },
      token,
    );
    for (const ev of resp.items ?? []) out.push(ev);
    if (!resp.nextPageToken) break;
    pageToken = resp.nextPageToken;
  }
  return out;
}

export async function createEvent(
  token: string,
  calendarId: string,
  body: Record<string, unknown>,
): Promise<CalendarEvent> {
  return (await calSend<CalendarEvent>(
    token,
    "POST",
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    body,
  ))!;
}

export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<CalendarEvent> {
  return (await calSend<CalendarEvent>(
    token,
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    patch,
  ))!;
}

export async function deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
  await calSend(
    token,
    "DELETE",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/calendar-client.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/calendar.ts src/google/__tests__/calendar-client.test.ts
git commit -m "feat(google): cliente de calendário com token explícito + create/update/delete"
```

---

### Task 7: `calendar-tool.ts` — 5 tools MCP (cola fina, account-scoped)

**Files:**
- Create: `src/google/calendar-tool.ts`
- Test: `src/google/__tests__/calendar-tool.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/calendar-tool.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCalendarTools } from "../calendar-tool.js";

function fakeServer() {
  const tools = new Map<string, (args: any) => Promise<any>>();
  const server = { tool: (name: string, _d: string, _s: any, h: any) => tools.set(name, h) };
  return { server: server as any, tools };
}

test("registra as 5 tools de calendário", () => {
  const { server, tools } = fakeServer();
  registerCalendarTools(server);
  assert.deepEqual(
    [...tools.keys()].sort(),
    ["create_calendar_event", "delete_calendar_event", "list_calendars", "list_events", "update_calendar_event"],
  );
});

test("delete_calendar_event sem confirm não chama a rede e exige confirmação", async () => {
  const { server, tools } = fakeServer();
  registerCalendarTools(server);
  const res = await tools.get("delete_calendar_event")!({ calendar_ref: "x", event_id: "y", confirm: false });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "confirm_required");
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/calendar-tool.test.ts`
Expected: FAIL ("Cannot find module ../calendar-tool.js").

- [ ] **Step 3: Implementar**

```ts
// src/google/calendar-tool.ts
// 5 tools MCP de Google Calendar. Cola fina: a conta vem SEMPRE de getAccountId()
// (contexto confiável), nunca do input; o calendar_ref é validado contra as
// contas conectadas dessa conta (resolveCalendarRef). Cada handler tem try/catch
// próprio (amigos não recebem o wrapper de erro de tools.ts). delete exige confirm.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccountId } from "../context.js";
import { auditWrite } from "../audit.js";
import { getGoogleAccounts } from "./google-accounts.js";
import { getGoogleAccessTokenFor, resolveCalendarRef } from "./google-token.js";
import {
  listCalendarsWithToken,
  listEventsWithToken,
  createEvent,
  updateEvent,
  deleteEvent,
} from "./calendar.js";
import { encodeCalendarRef } from "./calendar-ref.js";
import { buildEventPayload, buildEventPatch } from "./event-payload.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function fail(error: string, message: string) {
  return json({ ok: false, error, message });
}

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "list_calendars",
    `Lista as agendas (calendários) de TODAS as contas Google que a pessoa conectou no portal do Zinom. Use antes de criar/editar/excluir para descobrir o "calendar_ref" da agenda certa. Cada item traz calendar_ref (opaco, use exatamente como veio), summary (nome), email (qual conta Google), primary e accessRole. Se não vier nenhuma, a pessoa ainda não conectou um Google no portal.`,
    {},
    async () => {
      const accountId = getAccountId();
      try {
        const accounts = await getGoogleAccounts(accountId);
        const calendars: Array<Record<string, unknown>> = [];
        for (const acc of accounts) {
          try {
            const token = await getGoogleAccessTokenFor(accountId, acc.email);
            for (const c of await listCalendarsWithToken(token)) {
              calendars.push({
                calendar_ref: encodeCalendarRef(acc.email, c.id),
                summary: c.summary ?? c.id,
                email: acc.email,
                primary: !!c.primary,
                accessRole: c.accessRole,
              });
            }
          } catch (e: any) {
            calendars.push({ email: acc.email, error: e?.message ?? String(e) });
          }
        }
        return json({ ok: true, calendars });
      } catch (e: any) {
        return fail("list_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "list_events",
    `Lista eventos ao vivo de uma agenda num intervalo de tempo. Use calendar_ref vindo de list_calendars. time_min e time_max são ISO 8601 (ex.: "2026-06-09T00:00:00-03:00"). Calcule datas absolutas a partir de "hoje"/"amanhã"/"esta semana" usando a data atual.`,
    {
      calendar_ref: z.string().describe("O calendar_ref vindo de list_calendars"),
      time_min: z.string().describe("Início da janela, ISO 8601"),
      time_max: z.string().describe("Fim da janela, ISO 8601"),
    },
    async ({ calendar_ref, time_min, time_max }) => {
      const accountId = getAccountId();
      try {
        const { calendarId, token } = await resolveCalendarRef(accountId, calendar_ref);
        const events = await listEventsWithToken(token, { calendarId, timeMin: time_min, timeMax: time_max });
        return json({
          ok: true,
          events: events.map((e) => ({
            id: e.id,
            summary: e.summary,
            start: e.start,
            end: e.end,
            location: e.location,
            htmlLink: e.htmlLink,
          })),
        });
      } catch (e: any) {
        return fail("list_events_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "create_calendar_event",
    `Cria um evento numa agenda da pessoa. Use calendar_ref de list_calendars. start/end em ISO 8601 (com fuso, ex.: "2026-06-09T15:00:00-03:00"); para dia inteiro passe all_day=true e datas "YYYY-MM-DD". Calcule a data absoluta a partir de "amanhã 15h" etc. usando a data atual. Responde com o link do evento criado.`,
    {
      calendar_ref: z.string().describe("calendar_ref de list_calendars"),
      summary: z.string().min(1).describe("Título do evento"),
      start: z.string().describe("Início ISO 8601 (ou YYYY-MM-DD se all_day)"),
      end: z.string().describe("Fim ISO 8601 (ou YYYY-MM-DD se all_day)"),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Emails dos convidados"),
      timezone: z.string().optional().describe("IANA, ex.: America/Sao_Paulo"),
      all_day: z.boolean().optional(),
    },
    async (args) => {
      const accountId = getAccountId();
      try {
        const { email, calendarId, token } = await resolveCalendarRef(accountId, args.calendar_ref);
        const body = buildEventPayload(args);
        const ev = await createEvent(token, calendarId, body);
        auditWrite("create_calendar_event", "google", { calendar: email, calendarId, event_id: ev.id }, { summary: args.summary });
        return json({ ok: true, id: ev.id, htmlLink: ev.htmlLink, message: "Evento criado." });
      } catch (e: any) {
        return fail("create_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "update_calendar_event",
    `Edita um evento existente. Use calendar_ref de list_calendars e event_id de list_events. Passe só os campos que mudam (summary, start, end, description, location, attendees, timezone, all_day).`,
    {
      calendar_ref: z.string(),
      event_id: z.string().describe("id do evento (de list_events)"),
      summary: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      timezone: z.string().optional(),
      all_day: z.boolean().optional(),
    },
    async (args) => {
      const accountId = getAccountId();
      try {
        const { email, calendarId, token } = await resolveCalendarRef(accountId, args.calendar_ref);
        const patch = buildEventPatch(args);
        const ev = await updateEvent(token, calendarId, args.event_id, patch);
        auditWrite("update_calendar_event", "google", { calendar: email, calendarId, event_id: args.event_id });
        return json({ ok: true, id: ev.id, htmlLink: ev.htmlLink, message: "Evento atualizado." });
      } catch (e: any) {
        return fail("update_failed", e?.message ?? String(e));
      }
    },
  );

  server.tool(
    "delete_calendar_event",
    `Exclui um evento. AÇÃO DESTRUTIVA: só executa com confirm=true. Use calendar_ref de list_calendars e event_id de list_events. Antes de chamar com confirm=true, confirme com a pessoa qual evento será excluído.`,
    {
      calendar_ref: z.string(),
      event_id: z.string(),
      confirm: z.boolean().describe("Precisa ser true para excluir de fato"),
    },
    async ({ calendar_ref, event_id, confirm }) => {
      if (!confirm) {
        return fail("confirm_required", "Para excluir, chame de novo com confirm=true após confirmar com a pessoa.");
      }
      const accountId = getAccountId();
      try {
        const { email, calendarId, token } = await resolveCalendarRef(accountId, calendar_ref);
        await deleteEvent(token, calendarId, event_id);
        auditWrite("delete_calendar_event", "google", { calendar: email, calendarId, event_id });
        return json({ ok: true, message: "Evento excluído." });
      } catch (e: any) {
        return fail("delete_failed", e?.message ?? String(e));
      }
    },
  );
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx tsx --test src/google/__tests__/calendar-tool.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/google/calendar-tool.ts src/google/__tests__/calendar-tool.test.ts
git commit -m "feat(google): 5 tools MCP de calendário (list/create/update/delete, account-scoped)"
```

---

### Task 8: `google-link.ts` (state do portal) + callback grava no vault

**Files:**
- Create: `src/portal/google-link.ts`
- Modify: `src/google/routes.ts` (imports + `GET /google/callback`)
- Test: `src/google/__tests__/google-link.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/google-link.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { putPortalGoogleState, takePortalGoogleState } from "../../portal/google-link.js";

test("put/take associa state ao accountId e é single-use", () => {
  const t0 = 1_000_000;
  putPortalGoogleState("st1", "acc:1", t0);
  assert.equal(takePortalGoogleState("st1", t0 + 1000), "acc:1");
  assert.equal(takePortalGoogleState("st1", t0 + 2000), null); // já consumido
});

test("state expirado retorna null", () => {
  const t0 = 1_000_000;
  putPortalGoogleState("st2", "acc:2", t0);
  assert.equal(takePortalGoogleState("st2", t0 + 11 * 60_000), null); // > TTL 10min
});

test("state desconhecido retorna null", () => {
  assert.equal(takePortalGoogleState("nope"), null);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/google-link.test.ts`
Expected: FAIL ("Cannot find module ../../portal/google-link.js").

- [ ] **Step 3a: Criar `google-link.ts`**

```ts
// src/portal/google-link.ts
// 001-account-portal / Google multi-conta — guarda o vínculo state OAuth ->
// accountId do portal entre o redirect e o /google/callback. Espelha
// notion-link.ts. In-memory (servidor single-instance), single-use, TTL 10min.
const STATE_TTL_MS = 10 * 60_000;
const states = new Map<string, { accountId: string; at: number }>();

function sweep(now: number): void {
  for (const [s, v] of states) if (now - v.at > STATE_TTL_MS) states.delete(s);
}

export function putPortalGoogleState(state: string, accountId: string, now: number = Date.now()): void {
  sweep(now);
  states.set(state, { accountId, at: now });
}

export function takePortalGoogleState(state: string, now: number = Date.now()): string | null {
  sweep(now);
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state);
  if (now - entry.at > STATE_TTL_MS) return null;
  return entry.accountId;
}
```

- [ ] **Step 3b: Estender o callback em `google/routes.ts`**

No topo, trocar o import da linha 8 por (adiciona `exchangeCodeRaw` e `SCOPES`):
```ts
import { authUrl, exchangeCode, exchangeCodeRaw, loadCreds, redirectUri, SCOPES } from "./oauth.js";
import { takePortalGoogleState } from "../portal/google-link.js";
import { addGoogleAccount } from "./google-accounts.js";
```

Dentro de `router.get("/google/callback", ...)`, logo após o bloco que trata `error` e ANTES da checagem `if (!code || !state || !pendingStates.has(state))`, inserir o ramo do portal:
```ts
    if (code && state) {
      const portalAccount = takePortalGoogleState(state);
      if (portalAccount) {
        try {
          const creds = await exchangeCodeRaw(code);
          if (!creds.granted_email) throw new Error("não consegui identificar o email da conta Google");
          await addGoogleAccount(portalAccount, {
            email: creds.granted_email,
            refresh_token: creds.refresh_token,
            scopes: SCOPES,
          });
          console.log(`[google-oauth] portal account ${portalAccount} connected ${creds.granted_email}`);
          res
            .type("html")
            .send(
              `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Conectado</title></head><body style="font-family:sans-serif;padding:40px;background:#1a1a2e;color:#e0e0e0"><h1 style="color:#4caf50">✅ Google conectado</h1><p>Conta: <code>${escape(creds.granted_email)}</code>. Pode fechar esta aba e voltar ao portal.</p></body></html>`,
            );
        } catch (err: any) {
          console.error("[google-oauth] portal callback failed:", err);
          res
            .status(500)
            .type("html")
            .send(`<h2 style='font-family:sans-serif;padding:40px'>Falha: ${escape(err.message ?? String(err))}</h2>`);
        }
        return;
      }
    }
```
(O ramo legado `pendingStates` que vem em seguida fica inalterado: continua atendendo o `/google/connect` admin que grava no arquivo único.)

- [ ] **Step 4: Rodar testes + build**

Run: `npx tsx --test src/google/__tests__/google-link.test.ts`
Expected: PASS (3 testes).
Run: `npm run build`
Expected: `tsc` sem erros.

- [ ] **Step 5: Commit**

```bash
git add src/portal/google-link.ts src/google/routes.ts src/google/__tests__/google-link.test.ts
git commit -m "feat(google): callback do portal grava conta Google no vault (multi-conta)"
```

---

### Task 9: Rotas do portal `/portal/google/{connect,accounts,disconnect}`

**Files:**
- Modify: `src/portal/routes.ts` (imports + 3 rotas dentro de `createPortalRouter`)

- [ ] **Step 1: Adicionar imports no topo de `routes.ts`**

Garantir que existam (adicionar os que faltarem):
```ts
import { randomBytes } from "node:crypto";
import { authUrl } from "../google/oauth.js";
import { putPortalGoogleState } from "./google-link.js";
import { listGoogleAccountsMasked, removeGoogleAccount } from "../google/google-accounts.js";
```

- [ ] **Step 2: Adicionar as rotas (logo após o bloco Granola, perto da linha 356)**

```ts
  // Google Calendar (multi-conta OAuth) --------------------------------------
  router.get("/portal/google/connect", requireSession, (_req, res) => {
    const state = randomBytes(16).toString("base64url");
    putPortalGoogleState(state, res.locals.accountId);
    res.redirect(302, authUrl(state));
  });

  router.get("/portal/google/accounts", requireSession, async (_req, res) => {
    res.json(await listGoogleAccountsMasked(res.locals.accountId));
  });

  router.post("/portal/google/disconnect", requireSession, async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    if (!email) {
      res.status(400).json({ error: "email obrigatório" });
      return;
    }
    const ok = await removeGoogleAccount(res.locals.accountId, email);
    res.sendStatus(ok ? 204 : 404);
  });
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `tsc` sem erros.

- [ ] **Step 4: Verificação manual rápida (dev portal)**

Run: `npm run dev:portal` (em outro terminal) e confirmar que o servidor sobe sem erro. (Fluxo completo de OAuth precisa de credenciais Google reais; coberto na Task 12.)

- [ ] **Step 5: Commit**

```bash
git add src/portal/routes.ts
git commit -m "feat(portal): rotas connect/accounts/disconnect do Google Calendar"
```

---

### Task 10: Registrar as tools no MCP (owner + amigo) + FRIEND_INSTRUCTIONS

**Files:**
- Modify: `src/index.ts:14` (import) e `src/index.ts:437-446` (registro)
- Modify: `src/mcp-account-config.ts:20-32` (FRIEND_INSTRUCTIONS)
- Test: `src/google/__tests__/friend-instructions.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/google/__tests__/friend-instructions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRIEND_INSTRUCTIONS } from "../../mcp-account-config.js";

test("FRIEND_INSTRUCTIONS cita as tools de calendário", () => {
  assert.ok(FRIEND_INSTRUCTIONS.includes("list_calendars"));
  assert.ok(FRIEND_INSTRUCTIONS.includes("create_calendar_event"));
  assert.ok(FRIEND_INSTRUCTIONS.includes("delete_calendar_event"));
});

test("FRIEND_INSTRUCTIONS continua sem vazar workspaces do Bruno", () => {
  for (const term of ["globalcripto", "nora", "Jean", "Luigi", "Victor"]) {
    assert.ok(!FRIEND_INSTRUCTIONS.includes(term));
  }
  assert.ok(!/\bpersonal\b/i.test(FRIEND_INSTRUCTIONS));
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx tsx --test src/google/__tests__/friend-instructions.test.ts`
Expected: FAIL (não menciona as tools ainda).

- [ ] **Step 3a: Atualizar `FRIEND_INSTRUCTIONS`**

Em `src/mcp-account-config.ts`, dentro da lista "Ferramentas disponíveis" do template, adicionar antes do bloco "Regras":
```
- **list_calendars** / **list_events** — vê as agendas e os eventos das contas Google que a pessoa conectou no portal. Use list_calendars primeiro para achar o calendar_ref certo.
- **create_calendar_event** / **update_calendar_event** / **delete_calendar_event** — cria, edita e exclui eventos diretamente na agenda do Google da pessoa. Sempre confirme antes de excluir; delete_calendar_event só executa com confirm=true. Converta "amanhã 15h" em ISO 8601 absoluto usando a data atual.
```
(Não usar nomes de workspace; manter o texto sem os termos proibidos do teste.)

- [ ] **Step 3b: Registrar as tools em `index.ts`**

Adicionar o import após a linha 14:
```ts
import { registerCalendarTools } from "./google/calendar-tool.js";
```
No bloco de registro (linhas 437-446), chamar nas DUAS pontas:
```ts
  if (owner) {
    registerTools(server);
    registerBrainSearchTool(server);
    registerBrainIndexUrlTool(server);
    registerBrainIndexWebTool(server);
    registerCalendarTools(server);
  } else {
    registerBrainSearchTool(server);
    registerBrainIndexWebTool(server);
    registerZinomTaskTool(server);
    registerCalendarTools(server);
  }
```

- [ ] **Step 4: Rodar testes + build**

Run: `npx tsx --test src/google/__tests__/friend-instructions.test.ts`
Expected: PASS (2 testes).
Run: `npm run build`
Expected: `tsc` sem erros.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/mcp-account-config.ts src/google/__tests__/friend-instructions.test.ts
git commit -m "feat(mcp): expõe as tools de calendário a owner e amigos + instruções"
```

---

### Task 11: UI do portal (seção Google Calendar)

**Files:**
- Modify: `portal/app.html`, `portal/app.js`

- [ ] **Step 1: Localizar a seção de iCal existente**

Run: `grep -n "ical\|iCal\|/portal/ical" portal/app.js portal/app.html | head -20`
Expected: encontra o card/funcs de iCal a espelhar (estilo, fetch, render).

- [ ] **Step 2: Adicionar o card no `app.html`**

Espelhando o card de iCal, adicionar uma seção "Google Calendar" com:
- um botão "Conectar conta Google" que abre `/portal/google/connect` (ex.: `<a href="/portal/google/connect" class="btn">Conectar conta Google</a>` — same-origin, segue o redirect do servidor);
- um container `<ul id="google-accounts"></ul>` para as contas conectadas.

- [ ] **Step 3: Adicionar a lógica no `app.js`**

```js
async function loadGoogleAccounts() {
  const res = await fetch("/portal/google/accounts", { credentials: "same-origin" });
  if (!res.ok) return;
  const accounts = await res.json();
  const ul = document.getElementById("google-accounts");
  ul.innerHTML = accounts.length
    ? accounts.map((a) =>
        `<li>${a.email} <button data-email="${a.email}" class="gdisc">Remover</button></li>`
      ).join("")
    : "<li>Nenhuma conta Google conectada.</li>";
  ul.querySelectorAll(".gdisc").forEach((b) =>
    b.addEventListener("click", async () => {
      await fetch("/portal/google/disconnect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: b.dataset.email }),
      });
      loadGoogleAccounts();
    })
  );
}
// chamar loadGoogleAccounts() no mesmo ponto em que a UI carrega as outras fontes.
```

- [ ] **Step 4: Build + verificação manual**

Run: `npm run build && npm run dev:portal`
Abrir o portal local, logar (magic link em modo dev: `PORTAL_EMAIL_DEV=1`), confirmar que o card "Google Calendar" aparece e o botão aponta para `/portal/google/connect`.

- [ ] **Step 5: Commit**

```bash
git add portal/app.html portal/app.js
git commit -m "feat(portal): UI para conectar/remover contas Google"
```

---

### Task 12: Suíte completa + docs + checklist operacional

**Files:**
- Modify: `README.md`, `docs/RUNBOOK.md`

- [ ] **Step 1: Suíte completa verde**

Run: `npm test`
Expected: PASS, incluindo os 6 arquivos novos em `src/google/__tests__/`.

- [ ] **Step 2: Build limpo**

Run: `npm run build`
Expected: `tsc` sem erros.

- [ ] **Step 3: Documentar Google Cloud + nota operacional**

No `README.md` (seção Calendars) e/ou `docs/RUNBOOK.md`, registrar:
```
## Google Calendar multi-conta (criar/editar/excluir)

Tools MCP: list_calendars, list_events, create_calendar_event,
update_calendar_event, delete_calendar_event. Cada usuário conecta suas contas
Google no portal (botão "Conectar conta Google"); os refresh tokens ficam no
vault criptografado (account_secrets, kind google_oauth), isolados por conta.

Configuração ÚNICA no Google Cloud (reusa o projeto existente):
1. Tela de consentimento OAuth: adicionar os escopos
   - https://www.googleapis.com/auth/calendar.readonly
   - https://www.googleapis.com/auth/calendar.events
2. Publishing status = "In production" (NÃO "Testing"): evita a expiração de
   7 dias do refresh token e a verificação do Google (mostra só o aviso
   "app não verificado", que o usuário aceita clicando).
3. Redirect URI /google/callback já está registrado (reusado).
4. Env já existentes: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
   BASE_URL, SECRETS_KEY.

Nota (dono usando via Claude Code): o bearer estático resolve account_id =
'bruno'. Para o Bruno enxergar pelas tools as contas Google que conectou pelo
portal, a conta 'bruno' precisa ter o email do portal do Bruno (account.email)
para que o login do portal caia no MESMO account_id 'bruno'.
```

- [ ] **Step 4: Checklist de verificação manual (e2e real, fora de teste)**

Após deploy com o consentimento configurado:
1. Portal: "Conectar conta Google" → consent → conta aparece em "contas conectadas".
2. Conectar uma segunda conta Google → as duas aparecem.
3. No Claude/Zinom: `list_calendars` mostra agendas das duas contas (com email).
4. "Cria um evento amanhã 15h na agenda X" → `create_calendar_event` → link retornado, evento aparece no Google Calendar.
5. "Edita o título desse evento" → `update_calendar_event` → muda no Google.
6. "Exclui esse evento" → pede confirmação → com confirm → some do Google.
7. Conta B não consegue operar agenda da conta A (isolamento) — coberto por teste; reconfirmar que cada login só vê o seu.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/RUNBOOK.md
git commit -m "docs(google): setup do Google Cloud + runbook do calendário multi-conta"
```

---

## Self-Review (preenchido)

**Spec coverage:**
- Multi-conta Google por tenant → Task 3 (store) + Task 8/9 (conexão portal). ✅
- Ler agendas/eventos ao vivo → Task 6 (cliente) + Task 7 (`list_calendars`/`list_events`). ✅
- Criar/editar/excluir → Task 2 (builders) + Task 6 (cliente) + Task 7 (tools); delete com confirm. ✅
- Escopos readonly+events → Task 4. ✅
- Isolamento por conta (calendar_ref validado) → Task 1 + Task 5. ✅
- Token por conta com refresh+cache → Task 5. ✅
- Conexão sem senha admin, via sessão do portal → Task 8 (callback) + Task 9 (rotas). ✅
- Tools para owner e amigos + FRIEND_INSTRUCTIONS → Task 10. ✅
- Auditoria em escrita → Task 7 (`auditWrite`). ✅
- Sem migração de banco (reusa account_secrets) → confirmado, nenhuma task de migração. ✅
- Google Cloud "em produção" + escopos → Task 12. ✅
- UI do portal → Task 11. ✅

**Placeholder scan:** sem TBD/TODO; todo passo com código/comando concretos. UI (Task 11) referencia o card iCal existente por ser HTML de baixo risco, mas entrega as funções JS e os contratos de endpoint completos.

**Type consistency:** `GoogleAccountEntry`/`GoogleAccountMasked` (Task 3) usados em Task 5/9; `encodeCalendarRef`/`decodeCalendarRef` (Task 1) em Task 5/7; `buildEventPayload`/`buildEventPatch` (Task 2) em Task 7; `resolveCalendarRef`/`getGoogleAccessTokenFor` (Task 5) em Task 7; `SCOPES`/`exchangeCodeRaw`/`refreshAccessToken` (Task 4) em Task 5/8; `listCalendarsWithToken`/`listEventsWithToken`/`createEvent`/`updateEvent`/`deleteEvent` (Task 6) em Task 7. Nomes batem ponta a ponta.
