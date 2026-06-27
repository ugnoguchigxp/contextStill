import { AsyncLocalStorage } from "node:async_hooks";
import type {
  RuntimeProviderPoolTarget,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "./settings.types.js";

export type ProviderLeaseRouteContext = {
  poolId: string;
  targetId: string;
};

const storage = new AsyncLocalStorage<ProviderLeaseRouteContext>();

function localLlmRouteTargetValue(model: {
  apiBaseUrl: string;
  apiPath?: string;
  model: string;
}): string {
  return JSON.stringify({
    apiBaseUrl: model.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: model.apiPath?.trim() || "/v1/chat/completions",
    model: model.model.trim(),
  });
}

function routeClaimGroupId(route: RuntimeSettingsRoute): string | null {
  if (route.provider === "auto") return null;
  return route.providerPoolId?.trim() || `task-routing:${route.provider}`;
}

function findLeaseTarget(params: {
  settings: RuntimeSettingsEditable;
  targetId: string;
}): RuntimeProviderPoolTarget | null {
  if (params.settings.providers["local-llm"].models.some((model) => model.id === params.targetId)) {
    return { provider: "local-llm", localLlmModelId: params.targetId };
  }
  if (/^\d+$/.test(params.targetId)) {
    return { provider: "azure-openai", deploymentSlot: Number(params.targetId) };
  }
  for (const provider of ["openai", "bedrock", "codex"] as const) {
    if (params.targetId === provider) return { provider, targetId: provider };
  }
  return null;
}

export function runWithProviderLeaseRouteContext<T>(
  context: ProviderLeaseRouteContext | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!context) return run();
  return storage.run(context, run);
}

export function applyProviderLeaseRouteContext(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeSettingsRoute {
  const context = storage.getStore();
  if (!context || routeClaimGroupId(route) !== context.poolId) return route;
  const target = findLeaseTarget({ settings, targetId: context.targetId });
  if (!target) return route;

  if (target.provider === "local-llm") {
    const model = settings.providers["local-llm"].models.find(
      (item) => item.id === target.localLlmModelId,
    );
    if (!model) return route;
    const routeTarget = localLlmRouteTargetValue(model);
    return {
      ...route,
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      fallback: [],
      azureDeploymentSlots: undefined,
    };
  }

  if (target.provider === "azure-openai") {
    return {
      ...route,
      provider: "azure-openai",
      fallback: [],
      azureDeploymentSlots: [target.deploymentSlot],
    };
  }

  return {
    ...route,
    provider: target.provider,
    fallback: [],
    azureDeploymentSlots: undefined,
  };
}
