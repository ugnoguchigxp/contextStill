import { groupedConfig } from "../../config.js";
import type { LlmHealthStatus, LlmProvider, LlmProviderName } from "./llm-provider.js";
import { recordLlmUsage } from "./llm-usage-logger.js";
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

function resolveDistillationProviderOrder(
  providerSetting: AgenticCompileProvider,
): LlmProviderName[] {
  if (providerSetting === "auto") {
    return ["local-llm", "azure-openai", "bedrock"];
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

function defaultModelForProvider(provider: LlmProviderName): string {
  switch (provider) {
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
): LlmProvider[] {
  const resolvedUsageSource = usageSource ?? "agentic-llm";
  return resolveProviderOrder(providerSetting).map((providerName) => {
    const provider = buildProvider(providerName, timeoutMs);
    return withUsageLogging(provider, resolvedUsageSource);
  });
}

export async function checkAgenticLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = 5000,
): Promise<AgenticLlmHealthStatus> {
  const fallbackOrder = resolveProviderOrder(providerSetting);
  const providers = getAgenticLlmProviders(providerSetting, timeoutMs, "health-check:agentic-llm");
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

export async function checkDistillationLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.distillation.provider,
  timeoutMs = groupedConfig.distillation.circuitBreakerHealthTimeoutMs,
): Promise<AgenticLlmHealthStatus> {
  const fallbackOrder = resolveDistillationProviderOrder(providerSetting);
  const providers = fallbackOrder.map((providerName) =>
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

  const firstProvider = providers[0] ?? createLocalLlmProvider({ timeoutMs });
  const firstStatus = await firstProvider.healthCheck();
  return {
    ...firstStatus,
    providerSetting,
    fallbackOrder,
    error:
      firstStatus.error ??
      (providerSetting === "auto"
        ? "No configured provider in distillation fallback chain"
        : `${providerSetting} is not configured`),
  };
}
