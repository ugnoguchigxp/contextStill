import { groupedConfig } from "../../config.js";
import type { LlmHealthStatus, LlmProvider, LlmProviderName } from "./llm-provider.js";
import { recordLlmUsage } from "./llm-usage-logger.js";
import { createOpenAiProvider } from "./providers/openai.provider.js";
import { createAzureOpenAiProvider } from "./providers/azure-openai.provider.js";
import { createBedrockProvider } from "./providers/bedrock.provider.js";
import { createLocalLlmProvider } from "./providers/local-llm.provider.js";

export type AgenticCompileProvider = "openai" | "azure-openai" | "bedrock" | "local-llm" | "auto";

export type AgenticLlmHealthStatus = LlmHealthStatus & {
  providerSetting: AgenticCompileProvider;
  selectedProvider?: LlmProviderName;
  fallbackOrder: LlmProviderName[];
};

function dedupeOrder(values: LlmProviderName[]): LlmProviderName[] {
  const seen = new Set<LlmProviderName>();
  const result: LlmProviderName[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveProviderOrder(
  providerSetting: AgenticCompileProvider,
  fallbackOrder: LlmProviderName[] = [],
): LlmProviderName[] {
  if (providerSetting === "auto") {
    return dedupeOrder(["openai", "azure-openai", "bedrock", "local-llm"]);
  }
  return dedupeOrder([providerSetting, ...fallbackOrder]);
}

function resolveDistillationProviderOrder(
  providerSetting: AgenticCompileProvider,
  fallbackOrder: LlmProviderName[] = [],
): LlmProviderName[] {
  if (providerSetting === "auto") {
    return dedupeOrder(["local-llm", "openai", "azure-openai", "bedrock"]);
  }
  return dedupeOrder([providerSetting, ...fallbackOrder]);
}

function buildProvider(provider: LlmProviderName, timeoutMs: number): LlmProvider {
  switch (provider) {
    case "openai":
      return createOpenAiProvider({ timeoutMs });
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

function defaultModelForProvider(provider: LlmProviderName): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.model;
    case "azure-openai":
      return groupedConfig.azureOpenAi.model;
    case "bedrock":
      return groupedConfig.bedrock.model;
    case "local-llm":
      return groupedConfig.localLlm.model;
  }
}

function withUsageLogging(provider: LlmProvider, source: string): LlmProvider {
  return {
    ...provider,
    async chat(request) {
      const response = await provider.chat(request);
      recordLlmUsage({
        provider: provider.name,
        model: defaultModelForProvider(provider.name),
        usage: response.usage,
        promptMessages: request.messages,
        completionText: response.content,
        source,
      });
      return response;
    },
  };
}

export function getAgenticLlmProviders(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = groupedConfig.agenticCompile.timeoutMs,
  usageSource?: string,
  fallbackOrder: LlmProviderName[] = [],
): LlmProvider[] {
  const resolvedUsageSource = usageSource ?? "agentic-llm";
  return resolveProviderOrder(providerSetting, fallbackOrder).map((providerName) => {
    const provider = buildProvider(providerName, timeoutMs);
    return withUsageLogging(provider, resolvedUsageSource);
  });
}

export async function checkAgenticLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = 5000,
  fallbackOrder: LlmProviderName[] = [],
): Promise<AgenticLlmHealthStatus> {
  const resolvedFallbackOrder = resolveProviderOrder(providerSetting, fallbackOrder);
  const providers = getAgenticLlmProviders(
    providerSetting,
    timeoutMs,
    "health-check:agentic-llm",
    fallbackOrder,
  );
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
        fallbackOrder: resolvedFallbackOrder,
      };
    }

    if (providerSetting !== "auto") {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder: resolvedFallbackOrder,
      };
    }
  }

  if (firstConfiguredStatus) {
    return {
      ...firstConfiguredStatus,
      providerSetting,
      selectedProvider: firstConfiguredStatus.provider,
      fallbackOrder: resolvedFallbackOrder,
    };
  }

  const firstProvider = providers[0] ?? createAzureOpenAiProvider({ timeoutMs });
  const firstStatus = await firstProvider.healthCheck();
  return {
    ...firstStatus,
    providerSetting,
    fallbackOrder: resolvedFallbackOrder,
    error:
      firstStatus.error ??
      (providerSetting === "auto"
        ? "No configured provider in fallback chain"
        : `${providerSetting} is not configured`),
  };
}

export async function checkDistillationLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.distillation.provider,
  timeoutMs = groupedConfig.distillation.circuitBreakerHealthTimeoutMs,
  fallbackOrder: LlmProviderName[] = [],
): Promise<AgenticLlmHealthStatus> {
  const resolvedFallbackOrder = resolveDistillationProviderOrder(providerSetting, fallbackOrder);
  const providers = resolvedFallbackOrder.map((providerName) =>
    withUsageLogging(buildProvider(providerName, timeoutMs), "health-check:distillation-llm"),
  );
  let firstConfiguredStatus: LlmHealthStatus | null = null;

  for (const provider of providers) {
    const status = await provider.healthCheck();
    if (!status.configured) {
      continue;
    }
    firstConfiguredStatus ??= status;
    if (status.reachable) {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder: resolvedFallbackOrder,
      };
    }
    if (providerSetting !== "auto") {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder: resolvedFallbackOrder,
      };
    }
  }

  if (firstConfiguredStatus) {
    return {
      ...firstConfiguredStatus,
      providerSetting,
      selectedProvider: firstConfiguredStatus.provider,
      fallbackOrder: resolvedFallbackOrder,
    };
  }

  const firstProvider = providers[0] ?? createLocalLlmProvider({ timeoutMs });
  const firstStatus = await firstProvider.healthCheck();
  return {
    ...firstStatus,
    providerSetting,
    fallbackOrder: resolvedFallbackOrder,
    error:
      firstStatus.error ??
      (providerSetting === "auto"
        ? "No configured provider in distillation fallback chain"
        : `${providerSetting} is not configured`),
  };
}
