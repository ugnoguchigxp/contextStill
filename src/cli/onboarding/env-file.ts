import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import type { SupportedLocale } from "../../shared/locales/locale.js";

const envAssignmentPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export type EnsureEnvFileInput = {
  envPath: string;
  envExamplePath: string;
  preferredLocale?: SupportedLocale;
};

export type EnsureEnvFileResult = {
  path: string;
  created: boolean;
  appendedKeys: string[];
};

function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(envAssignmentPattern);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

function parseMissingKeyLines(templateContent: string, existingKeys: Set<string>): string[] {
  const lines: string[] = [];
  for (const line of templateContent.split(/\r?\n/)) {
    const match = line.match(envAssignmentPattern);
    const key = match?.[1];
    if (!key || existingKeys.has(key)) continue;
    lines.push(line);
    existingKeys.add(key);
  }
  return lines;
}

export function parseEnvValues(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(envAssignmentPattern);
    if (!match?.[1]) continue;
    const key = match[1];
    const index = line.indexOf("=");
    values[key] = index >= 0 ? line.slice(index + 1).trim() : "";
  }
  return values;
}

export async function ensureEnvFile(input: EnsureEnvFileInput): Promise<EnsureEnvFileResult> {
  if (!existsSync(input.envExamplePath)) {
    throw new Error(`.env.example not found: ${input.envExamplePath}`);
  }

  let created = false;
  if (!existsSync(input.envPath)) {
    await copyFile(input.envExamplePath, input.envPath);
    created = true;
  }

  const templateContent = await readFile(input.envExamplePath, "utf8");
  const existingContent = await readFile(input.envPath, "utf8");
  const existingKeys = parseEnvKeys(existingContent);
  const appendLines = parseMissingKeyLines(templateContent, existingKeys);
  const appendedKeys = appendLines
    .map((line) => line.match(envAssignmentPattern)?.[1])
    .filter((key): key is string => Boolean(key));

  if (input.preferredLocale && !existingKeys.has("CONTEXT_STILL_LANG")) {
    appendLines.push(`CONTEXT_STILL_LANG=${input.preferredLocale}`);
    appendedKeys.push("CONTEXT_STILL_LANG");
  }

  if (appendLines.length > 0) {
    const suffix = existingContent.endsWith("\n") ? "" : "\n";
    const merged = `${existingContent}${suffix}\n${appendLines.join("\n")}\n`;
    await writeFile(input.envPath, merged, "utf8");
  }

  return {
    path: input.envPath,
    created,
    appendedKeys,
  };
}
