import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import type { StartupPlan } from "./onboarding.types.js";
import { parseEnvValues } from "../../cli/onboarding/env-file.js";

export const ALLOWED_ENV_KEYS = [
  "DATABASE_URL",
  "MEMORY_ROUTER_LANG",
  "MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER",
  "MEMORY_ROUTER_DISTILLATION_PROVIDER",
  "MEMORY_ROUTER_DISTILLATION_FIND_CANDIDATE_PROVIDER",
  "MEMORY_ROUTER_OPENAI_API_KEY",
  "MEMORY_ROUTER_OPENAI_API_BASE_URL",
  "MEMORY_ROUTER_OPENAI_MODEL",
  "MEMORY_ROUTER_AZURE_OPENAI_API_KEY",
  "MEMORY_ROUTER_AZURE_OPENAI_API_BASE_URL",
  "MEMORY_ROUTER_AZURE_OPENAI_MODEL",
  "MEMORY_ROUTER_AZURE_OPENAI_API_VERSION",
  "MEMORY_ROUTER_BEDROCK_MODEL",
  "MEMORY_ROUTER_BEDROCK_REGION",
  "MEMORY_ROUTER_BEDROCK_PROFILE",
  "MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL",
  "MEMORY_ROUTER_LOCAL_LLM_API_KEY",
  "MEMORY_ROUTER_LOCAL_LLM_MODEL",
  "MEMORY_ROUTER_EMBEDDING_PROVIDER",
  "MEMORY_ROUTER_EMBEDDING_DAEMON_URL",
  "MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN",
];

const envAssignmentPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function maskSecretValue(key: string, value: string): string {
  if (!value) return "";
  const normalizedKey = key.toUpperCase();
  if (
    normalizedKey.includes("KEY") ||
    normalizedKey.includes("PASSWORD") ||
    normalizedKey.includes("TOKEN") ||
    normalizedKey.includes("SECRET")
  ) {
    if (value.startsWith("sk-")) {
      return `sk-...${value.slice(-4)}`;
    }
    if (value.length <= 8) {
      return "****";
    }
    return `${value.slice(0, 3)}...${value.slice(-3)}`;
  }
  return value;
}

export function buildEnvRecord(plan: StartupPlan): Record<string, string> {
  const record: Record<string, string> = {};

  if (plan.lang) record["MEMORY_ROUTER_LANG"] = plan.lang;
  if (plan.database?.url) record["DATABASE_URL"] = plan.database.url;

  if (plan.compile?.provider) {
    record["MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER"] = plan.compile.provider;
  }

  // Compile LLM Provider specific configs
  if (plan.compile) {
    const cp = plan.compile;
    if (cp.provider === "openai" || cp.openaiKey) {
      if (cp.openaiKey) record["MEMORY_ROUTER_OPENAI_API_KEY"] = cp.openaiKey;
      if (cp.openaiBaseUrl) record["MEMORY_ROUTER_OPENAI_API_BASE_URL"] = cp.openaiBaseUrl;
      if (cp.openaiModel) record["MEMORY_ROUTER_OPENAI_MODEL"] = cp.openaiModel;
    }
    if (cp.provider === "azure-openai" || cp.azureKey) {
      if (cp.azureKey) record["MEMORY_ROUTER_AZURE_OPENAI_API_KEY"] = cp.azureKey;
      if (cp.azureBaseUrl) record["MEMORY_ROUTER_AZURE_OPENAI_API_BASE_URL"] = cp.azureBaseUrl;
      if (cp.azureModel) record["MEMORY_ROUTER_AZURE_OPENAI_MODEL"] = cp.azureModel;
      if (cp.azureVersion) record["MEMORY_ROUTER_AZURE_OPENAI_API_VERSION"] = cp.azureVersion;
    }
    if (cp.provider === "bedrock" || cp.bedrockModel) {
      if (cp.bedrockModel) record["MEMORY_ROUTER_BEDROCK_MODEL"] = cp.bedrockModel;
      if (cp.bedrockRegion) record["MEMORY_ROUTER_BEDROCK_REGION"] = cp.bedrockRegion;
      if (cp.bedrockProfile) record["MEMORY_ROUTER_BEDROCK_PROFILE"] = cp.bedrockProfile;
    }
    if (cp.provider === "local-llm" || cp.localLlmModel) {
      if (cp.localLlmBaseUrl) record["MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL"] = cp.localLlmBaseUrl;
      if (cp.localLlmKey) record["MEMORY_ROUTER_LOCAL_LLM_API_KEY"] = cp.localLlmKey;
      if (cp.localLlmModel) record["MEMORY_ROUTER_LOCAL_LLM_MODEL"] = cp.localLlmModel;
    }
  }

  // Distillation
  if (plan.distillation?.provider) {
    record["MEMORY_ROUTER_DISTILLATION_PROVIDER"] = plan.distillation.provider;
  }
  if (plan.distillation?.findCandidateProvider) {
    record["MEMORY_ROUTER_DISTILLATION_FIND_CANDIDATE_PROVIDER"] = plan.distillation.findCandidateProvider;
  }

  // Embedding
  if (plan.embedding?.provider) {
    record["MEMORY_ROUTER_EMBEDDING_PROVIDER"] = plan.embedding.provider;
    if (plan.embedding.daemonUrl) record["MEMORY_ROUTER_EMBEDDING_DAEMON_URL"] = plan.embedding.daemonUrl;
    if (plan.embedding.accessToken) record["MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN"] = plan.embedding.accessToken;
  }

  return record;
}

export function buildEnvDiff(plan: StartupPlan, currentEnvContent: string): string {
  const newRecord = buildEnvRecord(plan);
  const currentRecord = parseEnvValues(currentEnvContent);
  const lines: string[] = [];

  for (const key of ALLOWED_ENV_KEYS) {
    const newValue = newRecord[key];
    const currentValue = currentRecord[key];

    if (newValue !== undefined) {
      const maskedNew = maskSecretValue(key, newValue);
      if (currentValue === undefined) {
        lines.push(`+ ${key}=${maskedNew}`);
      } else if (currentValue !== newValue) {
        const maskedOld = maskSecretValue(key, currentValue);
        lines.push(`~ ${key}=${maskedOld} -> ${maskedNew}`);
      } else {
        lines.push(`  ${key}=${maskedNew} (unchanged)`);
      }
    }
  }

  return lines.join("\n");
}

export async function writeEnv(plan: StartupPlan, envPath: string): Promise<{ backupPath?: string }> {
  let backupPath: string | undefined;

  if (existsSync(envPath)) {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    backupPath = `${envPath}.bak-${timestamp}`;
    await copyFile(envPath, backupPath);
  }

  const newRecord = buildEnvRecord(plan);
  let currentContent = "";
  if (existsSync(envPath)) {
    currentContent = await readFile(envPath, "utf8");
  }

  const lines = currentContent.split(/\r?\n/);
  const keyToLineIndex = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(envAssignmentPattern);
    if (match?.[1]) {
      keyToLineIndex.set(match[1], i);
    }
  }

  const keysToWrite = Object.keys(newRecord).filter((k) => ALLOWED_ENV_KEYS.includes(k));
  const writtenKeys = new Set<string>();

  for (const key of keysToWrite) {
    const newValue = newRecord[key];
    if (keyToLineIndex.has(key)) {
      const index = keyToLineIndex.get(key)!;
      lines[index] = `${key}=${newValue}`;
      writtenKeys.add(key);
    }
  }

  // Append keys that don't exist in current file
  const appendLines: string[] = [];
  for (const key of keysToWrite) {
    if (!writtenKeys.has(key)) {
      appendLines.push(`${key}=${newRecord[key]}`);
    }
  }

  let finalContent = lines.join("\n");
  if (appendLines.length > 0) {
    const suffix = finalContent.endsWith("\n") || finalContent === "" ? "" : "\n";
    finalContent = `${finalContent}${suffix}${appendLines.join("\n")}\n`;
  }

  await writeFile(envPath, finalContent, "utf8");

  return { backupPath };
}
