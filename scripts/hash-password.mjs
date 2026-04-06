#!/usr/bin/env node
// Generates an OAUTH_PASSWORD_HASH suitable for .env.
// Usage: node scripts/hash-password.mjs '<your-password>'
import { scryptSync, randomBytes } from "node:crypto";

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: node scripts/hash-password.mjs '<password>'");
  process.exit(1);
}
if (pw.length < 12) {
  console.error("Refusing: password must be at least 12 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(pw, salt, 64);
const encoded = `${salt.toString("hex")}:${hash.toString("hex")}`;

console.log("Add this line to your .env file:");
console.log("");
console.log(`OAUTH_PASSWORD_HASH=${encoded}`);
console.log("");
console.log("And remove any existing OAUTH_PASSWORD= line.");
