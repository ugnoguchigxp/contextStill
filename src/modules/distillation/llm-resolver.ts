import { groupedConfig } from "../../config.js";

export type DistillationProviderName = "local-llm" | "azure-openai" | "bedrock";
export type DistillationProviderSetting = "local-llm" | "azure-openai" | "bedrock" | "auto";

export function resolveDistillationProviderOrder(
  setting: DistillationProviderSetting,
): DistillationProviderName[] {
  if (setting === "auto") {
    return ["local-llm", "azure-openai", "bedrock"];
  }
  return [setting];
}

export function defaultModelForProvider(provider: DistillationProviderName): string {
  switch (provider) {
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
    case "azure-openai":
      return Boolean(
        groupedConfig.azureOpenAi.apiKey.trim() &&
          groupedConfig.azureOpenAi.apiBaseUrl.trim() &&
          groupedConfig.azureOpenAi.model.trim(),
      );
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
