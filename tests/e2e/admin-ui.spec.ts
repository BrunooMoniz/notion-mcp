// tests/e2e/admin-ui.spec.ts — critérios de aceite da UX nova do /admin
// (branch fix/admin-ux-views): banner não coberto pela sidebar, navegação por
// views, tabela de Contas compacta com detalhe expansível, e tabbar mobile.
//
// Auto-suficiente: sobe o harness scripts/admin-preview.ts (renderHtml com
// fixture estática, SEM Postgres) num beforeAll e o derruba no afterAll.
// Não depende do webServer do playwright.config (dev-server do portal):
// todos os goto usam URL absoluta http://localhost:4799.
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4799;
const BASE = `http://localhost:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SECTION_IDS = [
  "sistema",
  "resumo",
  "receita",
  "funil",
  "engajamento",
  "custo",
  "qualidade-memoria",
  "uso-chat",
  "armazenamento",
  "leads",
  "contas",
] as const;

let preview: ChildProcess | null = null;

test.beforeAll(async () => {
  preview = spawn("npx", ["tsx", "scripts/admin-preview.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ADMIN_PREVIEW_PORT: String(PORT) },
    stdio: "pipe",
  });
  // Aguarda a porta responder (poll com timeout ~15s).
  const deadline = Date.now() + 15_000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`admin-preview não respondeu em ${BASE} após 15s: ${String(lastErr)}`);
});

test.afterAll(() => {
  preview?.kill("SIGTERM");
  preview = null;
});

// ---------------------------------------------------------------------------
// Desktop (1440×900)
// ---------------------------------------------------------------------------
test.describe("admin desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("A1: banner visível e não coberto pela sidebar", async ({ page }) => {
    await page.goto(`${BASE}/?msg=Convite%20enviado`);
    const banner = page.locator("#admin-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Convite enviado");
    const box = await banner.boundingBox();
    expect(box, "banner deve ter boundingBox").not.toBeNull();
    // Sidebar fixa tem 220px: o banner não pode começar embaixo dela.
    expect(box!.x).toBeGreaterThanOrEqual(220);
  });

  test("A5: banner de erro tem classe banner-err e fundo vermelho claro", async ({ page }) => {
    await page.goto(`${BASE}/?msg=Falha%20ao%20enviar&kind=err`);
    const banner = page.locator("#admin-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Falha ao enviar");
    // "banner-err", não "err": a classe curta colide com a .err dos textos de
    // erro de indexação (max-width:360px encolhia o banner).
    await expect(banner).toHaveClass(/(^|\s)banner-err(\s|$)/);
    const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(253, 236, 236)");
    // Regressão da colisão: o banner ocupa a largura do main, não 360px.
    const box = await banner.boundingBox();
    expect(box!.width).toBeGreaterThan(800);
  });

  test("A2: navegação por views via sidebar", async ({ page }) => {
    await page.goto(`${BASE}/`);
    // Sistema é a view default agora.
    await expect(page.locator("#sistema")).toBeVisible();
    await expect(page.locator("#contas")).toBeHidden();

    const navContas = page.locator('.nav-item[data-section="contas"]');
    await navContas.click();
    await expect(page.locator("#contas")).toBeVisible();
    await expect(page.locator("#sistema")).toBeHidden();
    await expect(navContas).toHaveClass(/(^|\s)active(\s|$)/);
    await expect(navContas).toHaveAttribute("aria-current", "true");
  });

  test("A2: deep-link /#leads mostra só a view leads", async ({ page }) => {
    await page.goto(`${BASE}/#leads`);
    await expect(page.locator("#leads")).toBeVisible();
    for (const id of SECTION_IDS) {
      if (id === "leads") continue;
      await expect(page.locator(`#${id}`)).toBeHidden();
    }
  });

  test("A2: hash inválido cai na view default (sistema)", async ({ page }) => {
    await page.goto(`${BASE}/#naoexiste`);
    await expect(page.locator("#sistema")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Sistema (painel de saúde) — TD
  // -------------------------------------------------------------------------
  test("TD: #sistema visível por default e é a primeira nav", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("#sistema")).toBeVisible();
    // Sistema é o primeiro item do sidebar.
    const firstNav = page.locator(".sidebar-nav .nav-item").first();
    await expect(firstNav).toHaveAttribute("data-section", "sistema");
  });

  test("TD: tile da VPS presente na seção Sistema", async ({ page }) => {
    await page.goto(`${BASE}/#sistema`);
    const vps = page.locator('#sistema [data-check="vps"]');
    await expect(vps).toBeVisible();
    // O fixture marca disco em 87%: gauge presente.
    await expect(vps).toContainText("Disco");
    await expect(vps).toContainText("87%");
  });

  test("TD: indicador de falha visível para o check com erro do fixture", async ({ page }) => {
    await page.goto(`${BASE}/#sistema`);
    // notion:personal está fail (HTTP 401) no fixture.
    const failTile = page.locator('#sistema [data-check="notion:personal"]');
    await expect(failTile).toBeVisible();
    await expect(failTile.locator('[data-field="state"]')).toContainText("falha");
    // Dot vermelho (#b3261e = rgb(179, 38, 30)).
    const dotBg = await failTile
      .locator('.hp-dot[data-field="dot"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dotBg).toBe("rgb(179, 38, 30)");
  });

  test("TD: barra de orçamento presente nos créditos", async ({ page }) => {
    await page.goto(`${BASE}/#sistema`);
    const budget = page.locator('#sistema [data-check="budget:anthropic"]');
    await expect(budget).toBeVisible();
    // Reusa o estilo .funnel-track/.funnel-bar para a barra de orçamento.
    await expect(budget.locator(".funnel-track .funnel-bar")).toBeVisible();
    await expect(budget).toContainText("85%");
  });

  test("A3: tabela de contas compacta, sem overflow, detalhe expansível", async ({ page }) => {
    await page.goto(`${BASE}/#contas`);
    await expect(page.locator("#contas")).toBeVisible();

    // Linhas principais compactas (≤ 64px).
    const rows = page.locator("tr.acct-row");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    for (let i = 0; i < rowCount; i++) {
      const box = await rows.nth(i).boundingBox();
      expect(box, `acct-row ${i} deve ter boundingBox`).not.toBeNull();
      expect(box!.height, `acct-row ${i} alta demais`).toBeLessThanOrEqual(64);
    }

    // Sem overflow horizontal na página.
    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noOverflow, "página não pode ter scroll horizontal").toBe(true);

    // ...nem DENTRO do wrapper da tabela: .table-wrap tem overflow-x:auto, então
    // a tabela poderia estourar e rolar internamente sem afetar o scrollWidth
    // da página. O critério A3 é caber em 1440px de verdade.
    const noTableOverflow = await page
      .locator("#contas .table-wrap")
      .evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(noTableOverflow, "tabela de contas não pode rolar horizontalmente em 1440px").toBe(true);

    // Todas as linhas de detalhe começam ocultas.
    const details = page.locator("tr.acct-detail");
    const detailCount = await details.count();
    expect(detailCount).toBeGreaterThan(0);
    for (let i = 0; i < detailCount; i++) {
      await expect(details.nth(i)).toBeHidden();
    }

    // Toggle da primeira conta abre o detalhe correspondente.
    const toggle = page.locator("button.acct-toggle").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls, "acct-toggle precisa de aria-controls").toBeTruthy();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = page.locator(`#${controls}`);
    await expect(detail).toBeVisible();
    // Fixture: a primeira conta é o friend com workspaces de nomes longos.
    await expect(detail).toContainText("Workspace Pessoal do Fulano");
    await expect(detail).toContainText("GlobalCripto Operações");
    await expect(detail).toContainText("Nora Finance Diretoria");
  });
});

// ---------------------------------------------------------------------------
// Mobile (390×844)
// ---------------------------------------------------------------------------
test.describe("admin mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("A6: tab ativo da tabbar visível e com alvo de toque ≥ 44px", async ({ page }) => {
    await page.goto(`${BASE}/#contas`);
    const activeTab = page.locator('.tabbar-mobile a[aria-current="true"]');
    await expect(activeTab).toBeVisible();
    const box = await activeTab.boundingBox();
    expect(box, "tab ativo deve ter boundingBox").not.toBeNull();
    // Dentro do viewport horizontal (0..390).
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    // Alvo de toque mínimo.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
