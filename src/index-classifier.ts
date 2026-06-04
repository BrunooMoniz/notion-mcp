// src/index-classifier.ts
// PM2 entrypoint for the brain-classifier process.
// Runs runClassifier() on cron, runRevisitar() once a day, and
// syncGranolasToReunioes() every 15 minutes.
import "dotenv/config";
import cron from "node-cron";
import { runClassifier } from "./classifier/notion-classifier.js";
import { runRevisitar } from "./classifier/revisitar.js";
import { syncGranolasToReunioes } from "./classifier/granola-to-reuniao.js";
import { recordRun } from "./rag/storage.js";

const CLASSIFIER_CRON = process.env.CLASSIFIER_CRON ?? "30 * * * *"; // half past every hour
const REVISITAR_CRON = process.env.REVISITAR_CRON ?? "0 7 * * *";    // 07:00 every day
const GRANOLA_REUNIAO_CRON = process.env.GRANOLA_REUNIAO_CRON ?? "*/15 * * * *"; // every 15min

async function tickClassifier(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runClassifier();
    console.log(
      `[${new Date().toISOString()}] [classifier:${label}] scanned=${stats.scanned} classified=${stats.classified} ` +
        `pessoas(linked=${stats.pessoas_linked} created=${stats.pessoas_created}) orgs(linked=${stats.orgs_linked} created=${stats.orgs_created}) ` +
        `errors=${stats.errors} took=${Date.now() - start}ms`,
    );
    await recordRun({ worker: "classifier", source: "classifier", ok: stats.errors === 0, counts: stats, startedAt: new Date(start), endedAt: new Date() });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [classifier:${label}] FAILED`, err);
    await recordRun({ worker: "classifier", source: "classifier", ok: false, error: err instanceof Error ? err.message : String(err), startedAt: new Date(start), endedAt: new Date() });
  }
}

async function tickRevisitar(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runRevisitar();
    console.log(
      `[${new Date().toISOString()}] [revisitar:${label}] candidates=${stats.candidates} created=${stats.created} took=${Date.now() - start}ms`,
    );
    await recordRun({ worker: "classifier", source: "revisitar", ok: true, counts: stats, startedAt: new Date(start), endedAt: new Date() });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [revisitar:${label}] FAILED`, err);
    await recordRun({ worker: "classifier", source: "revisitar", ok: false, error: err instanceof Error ? err.message : String(err), startedAt: new Date(start), endedAt: new Date() });
  }
}

async function tickGranolaReuniao(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await syncGranolasToReunioes();
    console.log(
      `[${new Date().toISOString()}] [granola->reuniao:${label}] scanned=${stats.scanned} created=${stats.created} ` +
        `appended=${stats.appended} skipped=${stats.skipped} errors=${stats.errors} took=${Date.now() - start}ms`,
    );
    await recordRun({ worker: "classifier", source: "granola-reuniao", ok: stats.errors === 0, counts: stats, startedAt: new Date(start), endedAt: new Date() });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [granola->reuniao:${label}] FAILED`, err);
    await recordRun({ worker: "classifier", source: "granola-reuniao", ok: false, error: err instanceof Error ? err.message : String(err), startedAt: new Date(start), endedAt: new Date() });
  }
}

console.log(
  `brain-classifier starting; classifier cron: ${CLASSIFIER_CRON}; revisitar cron: ${REVISITAR_CRON}; granola->reuniao cron: ${GRANOLA_REUNIAO_CRON}`,
);
console.log("running initial classifier tick...");
void tickClassifier("initial");
console.log("running initial revisitar tick...");
void tickRevisitar("initial");
console.log("running initial granola->reuniao tick...");
void tickGranolaReuniao("initial");

cron.schedule(CLASSIFIER_CRON, () => {
  void tickClassifier("cron");
});
cron.schedule(REVISITAR_CRON, () => {
  void tickRevisitar("cron");
});
cron.schedule(GRANOLA_REUNIAO_CRON, () => {
  void tickGranolaReuniao("cron");
});
