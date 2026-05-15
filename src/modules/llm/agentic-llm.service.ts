import { groupedConfig } from "../../config.js";
import type { LlmHealthStatus, LlmProvider, LlmProviderName } from "./llm-provider.js";
import { createAzureOpenAiProvider } from "./providers/azure-openai.provider.js";
import { createBedrockProvider } from "./providers/bedrock.provider.js";
import { createLocalLlmProvider } from "./providers/local-llm.provider.js";

export type AgenticCompileProvider = "azure-openai" | "bedrock" | "local-llm" | "auto";

export type AgenticLlmHealthStatus = LlmHealthStatus & {
  providerSetting: AgenticCompileProvider;
  selectedProvider?: LlmProviderName;
  fallbackOrder: LlmProviderName[];
};

function resolveProviderOrder(providerSetting: AgenticCompileProvider): LlmProviderName[] {
  if (providerSetting === "auto") {
    return ["azure-openai", "bedrock", "local-llm"];
  }
  return [providerSetting];
}

function buildProvider(provider: LlmProviderName, timeoutMs: number): LlmProvider {
  switch (provider) {
    case "azure-openai":
      return createAzureOpenAiProvider({ timeoutMs });
    case "bedrock":
      return createBedrockProvider({ timeoutMs });
    case "local-llm":
      return createLocalLlmProvider({ timeoutMs });
    default:
      return createAzureOpenAiProvider({ timeoutMs });
  }
}

export function getAgenticLlmProviders(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = groupedConfig.agenticCompile.timeoutMs,
): LlmProvider[] {
  return resolveProviderOrder(providerSetting).map((providerName) =>
    buildProvider(providerName, timeoutMs),
  );
}

export async function checkAgenticLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = 5000,
): Promise<AgenticLlmHealthStatus> {
  const fallbackOrder = resolveProviderOrder(providerSetting);
  const providers = getAgenticLlmProviders(providerSetting, timeoutMs);
  let firstConfiguredStatus: LlmHealthStatus | null = null;

  for (const provider of providers) {
    const status = await provider.healthCheck();
    if (!status.configured) {
      continue;
    }

    if (!firstConfiguredStatus) {
      firstConfiguredStatus = status;
    }

    if (status.reachable) {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder,
      };
    }

    if (providerSetting !== "auto") {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder,
      };
    }
  }

  if (firstConfiguredStatus) {
    return {
      ...firstConfiguredStatus,
      providerSetting,
      selectedProvider: firstConfiguredStatus.provider,
      fallbackOrder,
    };
  }

  const firstProvider = providers[0] ?? createAzureOpenAiProvider({ timeoutMs });
  const firstStatus = await firstProvider.healthCheck();
  return {
    ...firstStatus,
    providerSetting,
    fallbackOrder,
    error:
      firstStatus.error ??
      (providerSetting === "auto"
        ? "No configured provider in fallback chain"
        : `${providerSetting} is not configured`),
  };
}
