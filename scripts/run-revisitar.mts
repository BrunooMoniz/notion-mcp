// scripts/run-revisitar.mts
import "dotenv/config";
import { runRevisitar } from "../src/classifier/revisitar.js";

async function main() {
  const stats = await runRevisitar();
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
