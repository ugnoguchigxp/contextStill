import { groupedConfig } from "../../../config.js";

export type ResolvedLocalLlmModelConfig = {
  apiBaseUrl: string;
  apiPath: string;
  apiKey?: string;
  model: string;
};

function parseLocalLlmRouteTarget(value: string | undefined): ResolvedLocalLlmModelConfig | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ResolvedLocalLlmModelConfig>;
    if (typeof parsed.apiBaseUrl === "string" && typeof parsed.model === "string") {
      const apiBaseUrl = parsed.apiBaseUrl.trim().replace(/\/+$/, "");
      const apiPath =
        typeof parsed.apiPath === "string" && parsed.apiPath.trim()
          ? parsed.apiPath.trim()
          : "/v1/chat/completions";
      const model = parsed.model.trim();
      if (apiBaseUrl && model) return { apiBaseUrl, apiPath, model };
    }
  } catch {
    // Legacy route values are plain model names.
  }
  return null;
}

export function resolveLocalLlmModelConfig(model?: string): ResolvedLocalLlmModelConfig {
  const requestedModel = model?.trim();
  const requestedTarget = parseLocalLlmRouteTarget(requestedModel);
  const configuredModels = (groupedConfig.localLlm.models ?? []).filter(
    (item) => item.apiBaseUrl.trim() && item.model.trim(),
  );
  const matched = requestedTarget
    ? configuredModels.find(
        (item) =>
          item.apiBaseUrl.replace(/\/+$/, "") === requestedTarget.apiBaseUrl &&
          (!requestedTarget.apiPath ||
            (item.apiPath?.trim() || "/v1/chat/completions") === requestedTarget.apiPath) &&
          item.model === requestedTarget.model,
      )
    : requestedModel
      ? configuredModels.find((item) => item.model === requestedModel)
      : undefined;
  const selected = matched ?? configuredModels[0];
  return {
    apiBaseUrl: (
      selected?.apiBaseUrl ||
      requestedTarget?.apiBaseUrl ||
      groupedConfig.localLlm.apiBaseUrl
    ).replace(/\/+$/, ""),
    apiPath:
      selected?.apiPath ||
      requestedTarget?.apiPath ||
      groupedConfig.localLlm.apiPath ||
      "/v1/chat/completions",
    apiKey:
      selected && "apiKey" in selected ? selected.apiKey : groupedConfig.localLlm.apiKey || "",
    model:
      selected?.model || requestedTarget?.model || requestedModel || groupedConfig.localLlm.model,
  };
}

export function buildLocalLlmChatCompletionsUrl(
  apiBaseUrl: string,
  apiPath = "/v1/chat/completions",
): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const path = apiPath.trim() || "/v1/chat/completions";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    return `${base}${normalizedPath.slice(3)}`;
  }
  return `${base}${normalizedPath}`;
}
