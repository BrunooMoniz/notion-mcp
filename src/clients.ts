import { Client } from "@notionhq/client";
import { assertWorkspaceScope } from "./context.js";

const notionTokens = [
  "NOTION_GLOBALCRIPTO_TOKEN",
  "NOTION_PERSONAL_TOKEN",
  "NOTION_NORA_TOKEN",
] as const;

for (const key of notionTokens) {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  if (!val.startsWith("ntn_")) {
    console.error(`Invalid format for ${key}: must start with "ntn_"`);
    process.exit(1);
  }
}

if (!process.env.OAUTH_PASSWORD_HASH) {
  console.error(
    "Missing required environment variable: OAUTH_PASSWORD_HASH.\n" +
      "Generate one with: node scripts/hash-password.mjs '<your-password>'"
  );
  process.exit(1);
}

const bearerToken = process.env.BEARER_TOKEN;
if (bearerToken && bearerToken.length < 32) {
  console.error("BEARER_TOKEN must be at least 32 characters");
  process.exit(1);
}

export const globalcriptoClient = new Client({
  auth: process.env.NOTION_GLOBALCRIPTO_TOKEN!,
});

export const personalClient = new Client({
  auth: process.env.NOTION_PERSONAL_TOKEN!,
});

export const noraClient = new Client({
  auth: process.env.NOTION_NORA_TOKEN!,
});

export type Workspace = "globalcripto" | "personal" | "nora";

export const ALL_WORKSPACES: Workspace[] = ["globalcripto", "personal", "nora"];

export function getClient(workspace: Workspace): Client {
  // Per-request scope enforcement (no-op when there's no HTTP context).
  assertWorkspaceScope(workspace);
  switch (workspace) {
    case "globalcripto":
      return globalcriptoClient;
    case "personal":
      return personalClient;
    case "nora":
      return noraClient;
    default: {
      const _exhaustive: never = workspace;
      throw new Error(`Unknown workspace: ${_exhaustive}`);
    }
  }
}
