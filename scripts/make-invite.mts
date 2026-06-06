// scripts/make-invite.mts
// 001-account-portal — operator CLI to mint a single-use invite code.
//
//   npm run make-invite                 # prints a fresh code (once)
//   npm run make-invite -- --label "Alice"
//
// Only the SHA-256 hash is stored in invite_codes; the plaintext is printed here
// and never again. Deliver it to the friend out-of-band. Needs POSTGRES_URL.
import "dotenv/config";
import { generateInviteCode, hashInvite } from "../src/portal/invites.js";
import { getPool, closePool } from "../src/rag/storage.js";

async function main(): Promise<void> {
  if (!process.env.POSTGRES_URL) {
    console.error("POSTGRES_URL is not set");
    process.exit(1);
  }
  const labelIdx = process.argv.indexOf("--label");
  const label = labelIdx !== -1 ? process.argv[labelIdx + 1] : undefined;

  const code = generateInviteCode();
  await getPool().query(
    `INSERT INTO invite_codes (code_hash, label) VALUES ($1, $2)`,
    [hashInvite(code), label ?? null],
  );
  await closePool();

  console.log("");
  console.log("  Convite gerado (aparece só uma vez):");
  console.log("");
  console.log(`    ${code}`);
  console.log("");
  if (label) console.log(`  Label: ${label}`);
  console.log("  Entregue este código ao amigo. Ele usa em /portal junto do e-mail.");
  console.log("");
}

void main();
