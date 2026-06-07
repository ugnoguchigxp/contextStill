import { groupedConfig } from "../../../config.js";

export type ResolvedLocalLlmModelConfig = {
  apiBaseUrl: string;
  model: string;
};

export function resolveLocalLlmModelConfig(model?: string): ResolvedLocalLlmModelConfig {
  const requestedModel = model?.trim();
  const configuredModels = (groupedConfig.localLlm.models ?? []).filter(
    (item) => item.apiBaseUrl.trim() && item.model.trim(),
  );
  const matched = requestedModel
    ? configuredModels.find((item) => item.model === requestedModel)
    : undefined;
  const selected = matched ?? configuredModels[0];
  return {
    apiBaseUrl: (selected?.apiBaseUrl || groupedConfig.localLlm.apiBaseUrl).replace(/\/+$/, ""),
    model: selected?.model || requestedModel || groupedConfig.localLlm.model,
  };
}

export function buildLocalLlmChatCompletionsUrl(apiBaseUrl: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}
