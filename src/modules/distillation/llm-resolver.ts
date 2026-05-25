import { groupedConfig } from "../../config.js";
import { isAzureOpenAiConfigured } from "../llm/providers/azure-openai-config.js";

export type DistillationProviderName = "local-llm" | "openai" | "azure-openai" | "bedrock";
export type DistillationProviderSetting =
  | "local-llm"
  | "openai"
  | "azure-openai"
  | "bedrock"
  | "auto";

function dedupeProviderOrder(values: DistillationProviderName[]): DistillationProviderName[] {
  const seen = new Set<DistillationProviderName>();
  const ordered: DistillationProviderName[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

export function resolveDistillationProviderOrder(
  setting: DistillationProviderSetting,
  fallbackOrder: DistillationProviderName[] = [],
): DistillationProviderName[] {
  if (setting === "auto") {
    return ["local-llm", "openai", "azure-openai", "bedrock"];
  }
  return dedupeProviderOrder([setting, ...fallbackOrder]);
}

export function defaultModelForProvider(provider: DistillationProviderName): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.model;
    case "azure-openai":
      return groupedConfig.azureOpenAi.model;
    case "bedrock":
      return groupedConfig.bedrock.model;
    default:
      return groupedConfig.localLlm.model;
  }
}

export function isProviderConfigured(provider: DistillationProviderName): boolean {
  switch (provider) {
    case "openai":
      return Boolean(
        groupedConfig.openAi.apiKey.trim() &&
          groupedConfig.openAi.apiBaseUrl.trim() &&
          groupedConfig.openAi.model.trim(),
      );
    case "azure-openai":
      return isAzureOpenAiConfigured();
    case "bedrock":
      return Boolean(groupedConfig.bedrock.region.trim() && groupedConfig.bedrock.model.trim());
    default:
      return Boolean(
        groupedConfig.localLlm.apiBaseUrl.trim() && groupedConfig.localLlm.model.trim(),
      );
  }
}

export function resolveProviderForDistillation(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
): DistillationProviderName {
  const order = resolveDistillationProviderOrder(providerSetting);
  for (const provider of order) {
    if (isProviderConfigured(provider)) {
      return provider;
    }
  }
  return order[0] ?? "local-llm";
}

export function resolveDistillationModel(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
): string {
  return defaultModelForProvider(resolveProviderForDistillation(providerSetting));
}
