import { z } from "zod";
import { createAzureOpenAiProvider } from "../../../src/modules/llm/providers/azure-openai.provider.js";
import { createBedrockProvider } from "../../../src/modules/llm/providers/bedrock.provider.js";
import { createLocalLlmProvider } from "../../../src/modules/llm/providers/local-llm.provider.js";
import { createOpenAiProvider } from "../../../src/modules/llm/providers/openai.provider.js";
import { ensureRuntimeSettingsLoaded } from "../../../src/modules/settings/settings.service.js";
import {
  getRuntimeSettingsViewSnapshot,
  reloadRuntimeSettingsCache,
  saveRuntimeSettings,
} from "../../../src/modules/settings/settings.service.js";
import {
  type RuntimeSettingsUpdateRequest,
  settingsUpdateRequestSchema,
} from "../../../src/modules/settings/settings.types.js";

import {
  checkCodexAuthStatus,
  getCodexLoginCommand,
} from "../../../src/modules/codex/codex-auth.service.js";
import { createCodexProvider } from "../../../src/modules/llm/providers/codex.provider.js";

const providerNameSchema = z.enum([
  "openai",
  "azure-openai",
  "bedrock",
  "local-llm",
  "codex",
] as const);
const azureOpenAiDeploymentSchema = z.coerce.number().int().min(1).max(3);

export async function getSettingsForApi() {
  await ensureRuntimeSettingsLoaded();
  return getRuntimeSettingsViewSnapshot();
}

export async function updateSettingsForApi(input: RuntimeSettingsUpdateRequest) {
  const validated = settingsUpdateRequestSchema.parse(input);
  const saved = await saveRuntimeSettings(validated);
  const snapshot = getRuntimeSettingsViewSnapshot();
  return {
    ...snapshot,
    revision: saved.revision,
    updatedAt: saved.updatedAt,
    cacheInvalidated: true,
    reloadRequired: true,
  };
}

export async function reloadRuntimeCacheForApi() {
  await reloadRuntimeSettingsCache();
  return {
    ok: true as const,
    reloadedAt: new Date().toISOString(),
  };
}

export async function testProviderForApi(providerRaw: string) {
  await ensureRuntimeSettingsLoaded();
  const provider = providerNameSchema.parse(providerRaw);
  switch (provider) {
    case "openai":
      return createOpenAiProvider({ timeoutMs: 10_000 }).healthCheck();
    case "azure-openai":
      return createAzureOpenAiProvider({ timeoutMs: 10_000 }).healthCheck();
    case "bedrock":
      return createBedrockProvider({ timeoutMs: 10_000 }).healthCheck();
    case "local-llm":
      return createLocalLlmProvider({ timeoutMs: 10_000 }).healthCheck();
    case "codex":
      return createCodexProvider({ timeoutMs: 10_000 }).healthCheck();
  }
}

export async function testAzureOpenAiDeploymentForApi(deploymentRaw: string | number) {
  await ensureRuntimeSettingsLoaded();
  const deployment = azureOpenAiDeploymentSchema.parse(deploymentRaw);
  return createAzureOpenAiProvider({
    timeoutMs: 10_000,
    deploymentIndex: deployment - 1,
  }).healthCheck();
}

export async function getCodexAuthStatusForApi() {
  return checkCodexAuthStatus();
}

export function getCodexLoginCommandForApi() {
  return {
    command: getCodexLoginCommand(),
  };
}
