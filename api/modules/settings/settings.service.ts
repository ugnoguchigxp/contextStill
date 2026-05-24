import { z } from "zod";
import { ensureRuntimeSettingsLoaded } from "../../../src/modules/settings/settings.service.js";
import {
  getRuntimeSettingsViewSnapshot,
  reloadRuntimeSettingsCache,
  saveRuntimeSettings,
} from "../../../src/modules/settings/settings.service.js";
import {
  settingsUpdateRequestSchema,
  type RuntimeSettingsUpdateRequest,
} from "../../../src/modules/settings/settings.types.js";
import { createOpenAiProvider } from "../../../src/modules/llm/providers/openai.provider.js";
import { createAzureOpenAiProvider } from "../../../src/modules/llm/providers/azure-openai.provider.js";
import { createBedrockProvider } from "../../../src/modules/llm/providers/bedrock.provider.js";
import { createLocalLlmProvider } from "../../../src/modules/llm/providers/local-llm.provider.js";

const providerNameSchema = z.enum(["openai", "azure-openai", "bedrock", "local-llm"] as const);

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
  }
}
