// src/index-classifier.ts
// PM2 entrypoint for the brain-classifier process.
// Runs runClassifier() on cron and runRevisitar() once a day.
import "dotenv/config";
import cron from "node-cron";
import { runClassifier } from "./classifier/notion-classifier.js";
import { runRevisitar } from "./classifier/revisitar.js";

const CLASSIFIER_CRON = process.env.CLASSIFIER_CRON ?? "30 * * * *"; // half past every hour
const REVISITAR_CRON = process.env.REVISITAR_CRON ?? "0 7 * * *";    // 07:00 every day

async function tickClassifier(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runClassifier();
    console.log(
      `[${new Date().toISOString()}] [classifier:${label}] scanned=${stats.scanned} classified=${stats.classified} ` +
        `pessoas(linked=${stats.pessoas_linked} created=${stats.pessoas_created}) orgs(linked=${stats.orgs_linked} created=${stats.orgs_created}) ` +
        `errors=${stats.errors} took=${Date.now() - start}ms`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [classifier:${label}] FAILED`, err);
  }
}

async function tickRevisitar(label: string): Promise<void> {
  const start = Date.now();
  try {
    const stats = await runRevisitar();
    console.log(
      `[${new Date().toISOString()}] [revisitar:${label}] candidates=${stats.candidates} created=${stats.created} took=${Date.now() - start}ms`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [revisitar:${label}] FAILED`, err);
  }
}

console.log(`brain-classifier starting; classifier cron: ${CLASSIFIER_CRON}; revisitar cron: ${REVISITAR_CRON}`);
console.log("running initial classifier tick...");
void tickClassifier("initial");
console.log("running initial revisitar tick...");
void tickRevisitar("initial");

cron.schedule(CLASSIFIER_CRON, () => {
  void tickClassifier("cron");
});
cron.schedule(REVISITAR_CRON, () => {
  void tickRevisitar("cron");
});
