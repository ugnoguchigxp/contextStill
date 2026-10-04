import type {
  RuntimeProviderName,
  RuntimeSecretKey,
  RuntimeSettingsEditable,
  RuntimeSettingsView,
} from "../../../../../../src/modules/settings/settings.types";
export type {
  RuntimeProviderName,
  RuntimeProviderSetting,
  RuntimeSecretKey,
  RuntimeSecretSource,
  RuntimeSecretStatus,
  StaticRuntimeSettingsRoute,
  LarmAgentConnectionRoute,
  RuntimeSettingsRoute,
  FindCandidateThrottlingSettings,
  AzureOpenAiDeploymentSettings,
  LocalLlmModelSettings,
  LarmAgentConnectionSettings,
  RuntimeProviderPoolTarget,
  RuntimeProviderPool,
  RuntimeEffectiveProviderTarget,
  RuntimeEffectiveRouteTargets,
  RuntimeSettingsDiagnostic,
  RuntimeSettingsDiagnostics,
  DistillationPriorityTargetKind,
  RuntimeSettingsEditable,
  RuntimeSettingsView,
} from "../../../../../../src/modules/settings/settings.types";
export type RuntimeSearchProvider = "brave" | "exa" | "duckduckgo";
export type RuntimeSettingsSnapshotResponse = {
  settings: RuntimeSettingsView;
  effective: RuntimeSettingsView;
  sources: Record<string, string>;
  revision: number;
  loadedAt: string | null;
};

export type RuntimeSettingsUpdateRequest = {
  settings: RuntimeSettingsEditable;
  expectedRevision?: number;
  secrets?: Partial<
    Record<RuntimeSecretKey, { value?: string; clear?: boolean; useEnvironment?: boolean }>
  >;
  updatedBy?: string;
};

export type RuntimeSettingsUpdateResponse = RuntimeSettingsSnapshotResponse & {
  updatedAt: string;
  cacheInvalidated: boolean;
  reloadRequired: boolean;
};

export type RuntimeProviderHealth = {
  provider: RuntimeProviderName;
  configured: boolean;
  reachable: boolean;
  model: string;
  endpoint: string;
  error?: string;
};

export type RuntimeProviderHealthResponse = {
  provider: RuntimeProviderName;
  health: RuntimeProviderHealth;
};

export type RuntimeAzureOpenAiDeploymentHealthResponse = {
  provider: "azure-openai";
  deployment: number;
  health: RuntimeProviderHealth;
};

export type RuntimeLocalLlmModelHealthResponse = {
  provider: "local-llm";
  model: string;
  health: RuntimeProviderHealth;
};

export type RuntimeSettingsReloadResponse = {
  ok: true;
  reloadedAt: string;
};
