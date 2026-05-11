import { readFile } from "node:fs/promises";

import { z } from "zod";

import { mintProjectConfigSchema, MintProjectConfig } from "./schema.js";

export async function loadMintConfig(configPath: string): Promise<MintProjectConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read mint config ${configPath}: ${formatUnknownError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in mint config ${configPath}: ${formatUnknownError(error)}`);
  }

  const result = mintProjectConfigSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(formatConfigError(result.error));
  }

  return result.data;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatConfigError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${path}: ${issue.message}`;
  });

  return `Invalid mint config:\n${lines.join("\n")}`;
}
