import { groupedConfig } from "../../config.js";
import type { LlmHealthStatus, LlmProvider, LlmProviderName } from "./llm-provider.js";
import { recordLlmUsage } from "./llm-usage-logger.js";
import { configuredAzureOpenAiDeploymentSlots } from "./providers/azure-openai-config.js";
import { createAzureOpenAiProvider } from "./providers/azure-openai.provider.js";
import { createBedrockProvider } from "./providers/bedrock.provider.js";
import { createLocalLlmProvider } from "./providers/local-llm.provider.js";
import { createOpenAiProvider } from "./providers/openai.provider.js";
import { createCodexProvider } from "./providers/codex.provider.js";

export type AgenticCompileProvider = "openai" | "azure-openai" | "bedrock" | "local-llm" | "codex" | "auto";

export type AgenticLlmHealthStatus = LlmHealthStatus & {
  providerSetting: AgenticCompileProvider;
  selectedProvider?: LlmProviderName;
  fallbackOrder: LlmProviderName[];
  providerHealth?: LlmProviderHealthStatus[];
};

export type LlmProviderHealthStatus = LlmHealthStatus & {
  id: string;
  label: string;
  deploymentIndex?: number;
  selected: boolean;
  routeOrder: number | null;
};

type LlmProviderHealthEntry = {
  id: string;
  label: string;
  providerName: LlmProviderName;
  provider: LlmProvider;
  deploymentIndex?: number;
};

const nonAzureProviderNames: LlmProviderName[] = ["openai", "bedrock", "local-llm", "codex"];

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

function buildProvider(
  provider: LlmProviderName,
  timeoutMs: number,
  azureDeploymentSlots?: number[],
): LlmProvider {
  switch (provider) {
    case "openai":
      return createOpenAiProvider({ timeoutMs });
    case "azure-openai":
      return azureDeploymentSlots && azureDeploymentSlots.length > 0
        ? createAzureOpenAiProvider({ timeoutMs, deploymentSlots: azureDeploymentSlots })
        : createAzureOpenAiProvider({ timeoutMs });
    case "bedrock":
      return createBedrockProvider({ timeoutMs });
    case "local-llm":
      return createLocalLlmProvider({ timeoutMs });
    case "codex":
      return createCodexProvider({ timeoutMs });
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
    case "codex":
      return "codex-sdk-agent";
  }
}

function defaultEndpointForProvider(provider: LlmProviderName): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.apiBaseUrl;
    case "azure-openai":
      return groupedConfig.azureOpenAi.apiBaseUrl;
    case "bedrock":
      return groupedConfig.bedrock.region;
    case "local-llm":
      return groupedConfig.localLlm.apiBaseUrl;
    case "codex":
      return "codex-api";
  }
}

function defaultLabelForProvider(provider: LlmProviderName): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "azure-openai":
      return "Azure OpenAI";
    case "bedrock":
      return "Bedrock";
    case "local-llm":
      return "Local LLM";
    case "codex":
      return "Codex Auth";
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
  azureDeploymentSlots?: number[],
): LlmProvider[] {
  const resolvedUsageSource = usageSource ?? "agentic-llm";
  return resolveProviderOrder(providerSetting, fallbackOrder).map((providerName) => {
    const provider = buildProvider(providerName, timeoutMs, azureDeploymentSlots);
    return withUsageLogging(provider, resolvedUsageSource);
  });
}

export async function checkLlmProviderHealthMatrix(
  timeoutMs = 5000,
  options: {
    selectedProvider?: LlmProviderName;
    routeOrder?: LlmProviderName[];
    selectedAzureDeploymentSlots?: number[];
  } = {},
): Promise<LlmProviderHealthStatus[]> {
  const routeOrder = options.routeOrder ?? [];
  const selectedAzureDeploymentSlots = new Set(
    options.selectedAzureDeploymentSlots?.filter(
      (slot) => Number.isInteger(slot) && slot >= 1 && slot <= 3,
    ) ?? [],
  );
  const entries: LlmProviderHealthEntry[] = [];

  for (const providerName of nonAzureProviderNames) {
    const provider = buildProvider(providerName, timeoutMs);
    if (!provider.isConfigured()) continue;
    entries.push({
      id: providerName,
      label: defaultLabelForProvider(providerName),
      providerName,
      provider,
    });
  }

  for (const slot of configuredAzureOpenAiDeploymentSlots()) {
    entries.push({
      id: `azure-openai:${slot.index + 1}`,
      label: `Azure OpenAI #${slot.index + 1}`,
      providerName: "azure-openai",
      provider: createAzureOpenAiProvider({ timeoutMs, deploymentIndex: slot.index }),
      deploymentIndex: slot.index + 1,
    });
  }

  entries.sort((left, right) => {
    const leftRoute = routeOrder.indexOf(left.providerName);
    const rightRoute = routeOrder.indexOf(right.providerName);
    const leftRank = leftRoute >= 0 ? leftRoute : Number.MAX_SAFE_INTEGER;
    const rightRank = rightRoute >= 0 ? rightRoute : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.id.localeCompare(right.id);
  });

  return Promise.all(
    entries.map(async (entry) => {
      let status: LlmHealthStatus;
      try {
        status = await entry.provider.healthCheck();
      } catch (error) {
        status = {
          provider: entry.providerName,
          configured: entry.provider.isConfigured(),
          reachable: false,
          model: defaultModelForProvider(entry.providerName),
          endpoint: defaultEndpointForProvider(entry.providerName),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      status = {
        ...status,
        model: status.model ?? defaultModelForProvider(entry.providerName),
        endpoint: status.endpoint ?? defaultEndpointForProvider(entry.providerName),
      };
      const routeIndex = routeOrder.indexOf(entry.providerName);
      const selected =
        options.selectedProvider === entry.providerName &&
        (entry.providerName !== "azure-openai" ||
          selectedAzureDeploymentSlots.size === 0 ||
          (typeof entry.deploymentIndex === "number" &&
            selectedAzureDeploymentSlots.has(entry.deploymentIndex)));
      return {
        ...status,
        id: entry.id,
        label: entry.label,
        deploymentIndex: entry.deploymentIndex,
        selected,
        routeOrder: routeIndex >= 0 ? routeIndex : null,
      };
    }),
  );
}

export async function checkAgenticLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = 5000,
  fallbackOrder: LlmProviderName[] = [],
  azureDeploymentSlots?: number[],
): Promise<AgenticLlmHealthStatus> {
  const resolvedFallbackOrder = resolveProviderOrder(providerSetting, fallbackOrder);
  const providers = getAgenticLlmProviders(
    providerSetting,
    timeoutMs,
    "health-check:agentic-llm",
    fallbackOrder,
    azureDeploymentSlots,
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
