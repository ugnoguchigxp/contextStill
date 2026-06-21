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

function findPoolTarget(params: {
  settings: RuntimeSettingsEditable;
  poolId: string;
  targetId: string;
}): RuntimeProviderPoolTarget | null {
  const pool = params.settings.providerPools.find((item) => item.id === params.poolId);
  if (!pool) return null;
  return (
    pool.targets.find((target) => {
      if (target.provider === "local-llm") return target.localLlmModelId === params.targetId;
      if (target.provider === "azure-openai")
        return String(target.deploymentSlot) === params.targetId;
      return target.targetId === params.targetId;
    }) ?? null
  );
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
  if (!context || route.providerPoolId !== context.poolId) return route;
  const target = findPoolTarget({ settings, poolId: context.poolId, targetId: context.targetId });
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
