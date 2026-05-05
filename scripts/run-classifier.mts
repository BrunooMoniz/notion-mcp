// scripts/run-classifier.mts
// One-shot: run the classifier with explicit args, useful for manual runs / smoke tests.
import "dotenv/config";
import { runClassifier } from "../src/classifier/notion-classifier.js";

async function main() {
  const sinceDays = Number(process.env.CLASSIFIER_SINCE_DAYS ?? 7);
  const limit = Number(process.env.CLASSIFIER_LIMIT ?? 50);
  console.log(`Running classifier (sinceDays=${sinceDays}, limit=${limit})`);
  const stats = await runClassifier({ sinceDays, limit });
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
