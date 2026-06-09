// src/portal/__tests__/google-connect-unconfigured.test.ts
// GET /portal/google/connect com GOOGLE_OAUTH_CLIENT_ID ausente deve fazer
// redirect 302 para /app.html#fontes?google=unconfigured em vez de lançar 500.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createPortalRouter } from "../routes.js";
import { __setPoolForTest } from "../../rag/storage.js";
import { hashSession } from "../session.js";

const SID = "test-session-google";

function sessionPool() {
  return {
    query: async (sql: string, params: any[]) => {
      if (/SELECT account_id FROM portal_sessions/i.test(sql)) {
        return params[0] === hashSession(SID)
          ? { rows: [{ account_id: "acct_google_test" }] }
          : { rows: [] };
      }
      if (/UPDATE portal_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}

let server: Server;
let base = "";

before(async () => {
  __setPoolForTest(sessionPool() as never);
  const app = express();
  app.use(express.json());
  app.use(createPortalRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  __setPoolForTest(null);
});

test("GET /portal/google/connect sem GOOGLE_OAUTH_CLIENT_ID → 302 para #fontes?google=unconfigured", async () => {
  // Garantir que as envs estão ausentes
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  try {
    const res = await fetch(`${base}/portal/google/connect`, {
      method: "GET",
      headers: { cookie: `portal_session=${SID}` },
      redirect: "manual", // não seguir o redirect automaticamente
    });

    assert.equal(res.status, 302, "deve retornar 302");
    const loc = res.headers.get("location") ?? "";
    assert.ok(
      loc.includes("#fontes") && loc.includes("google=unconfigured"),
      `Location deve conter #fontes?google=unconfigured, recebeu: ${loc}`,
    );
  } finally {
    // restaurar envs para não poluir outros testes
    if (savedId !== undefined) process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
    if (savedSecret !== undefined) process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
  }
});

test("GET /portal/google/connect sem sessão → 401 (guard de sessão ainda funciona)", async () => {
  const res = await fetch(`${base}/portal/google/connect`, {
    method: "GET",
    redirect: "manual",
  });
  assert.equal(res.status, 401);
});
