import { Client } from "@notionhq/client";

const required = [
  "NOTION_GLOBALCRIPTO_TOKEN",
  "NOTION_PERSONAL_TOKEN",
  "NOTION_NORA_TOKEN",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
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

export function getClient(workspace: Workspace): Client {
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
