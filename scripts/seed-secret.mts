// scripts/seed-secret.mts — F3.1 ops helper: encrypt + store a per-account secret.
// Usage: SECRETS_KEY=... POSTGRES_URL=... npx tsx scripts/seed-secret.mts <accountId> <kind> <plaintext>
//   e.g. ... seed-secret.mts acme "notion_pat:personal" ntn_xxx
import "dotenv/config";
import { setAccountSecret } from "../src/secrets.js";
import { closePool } from "../src/rag/storage.js";

const [accountId, kind, plaintext] = process.argv.slice(2);
if (!accountId || !kind || !plaintext) {
  console.error("usage: tsx scripts/seed-secret.mts <accountId> <kind> <plaintext>");
  process.exit(1);
}
await setAccountSecret(accountId, kind, plaintext);
console.log(`stored secret for account=${accountId} kind=${kind} (encrypted, ${plaintext.length} chars in)`);
await closePool();
