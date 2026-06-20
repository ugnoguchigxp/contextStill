import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  formatDateTime as formatDateTimeTz,
  getRawTimezoneSetting,
  setTimezoneSetting,
  timezoneOptions,
  useTimezone,
} from "@/lib/timezone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Stethoscope, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type RuntimeProviderHealth,
  type RuntimeProviderName,
  type RuntimeProviderSetting,
  type RuntimeSearchProvider,
  type RuntimeSecretKey,
  type RuntimeSecretStatus,
  type RuntimeSettingsEditable,
  type RuntimeSettingsRoute,
  type RuntimeSettingsView,
  fetchCodexAuthStatus,
  fetchCodexLoginCommand,
  fetchRuntimeSettings,
  reloadRuntimeSettingsCache,
  testAzureOpenAiDeployment,
  testLocalLlmModel,
  testRuntimeProvider,
  updateRuntimeSettings,
} from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";

type SettingsTabId = "general" | "providers" | "taskRouting" | "search" | "embedding" | "advanced";
type SettingsTabPath =
  | "general"
  | "llmprovider"
  | "taskrouting"
  | "search"
  | "embedding"
  | "advanced";

type SecretDraftState = Partial<Record<RuntimeSecretKey, { value: string; clear: boolean }>>;

function azureOpenAiSecretKey(index: number): RuntimeSecretKey {
  return index === 0 ? "azureOpenAiApiKey" : (`azureOpenAiApiKey${index + 1}` as RuntimeSecretKey);
}

function emptyRuntimeSecretStatus(): RuntimeSecretStatus {
  return {
    configured: false,
    source: "none",
    maskedValue: null,
    updatedAt: null,
  };
}

const settingsTabs: Array<{ id: SettingsTabId; label: string; path: SettingsTabPath }> = [
  { id: "general", label: "General", path: "general" },
  { id: "providers", label: "LLM Providers", path: "llmprovider" },
  { id: "taskRouting", label: "Task Routing", path: "taskrouting" },
  { id: "search", label: "Search", path: "search" },
  { id: "embedding", label: "Embedding / Local Runtime", path: "embedding" },
  { id: "advanced", label: "Advanced", path: "advanced" },
];

const runtimeProviders: RuntimeProviderName[] = [
  "openai",
  "azure-openai",
  "bedrock",
  "local-llm",
  "codex",
];
const runtimeProviderOptions: RuntimeProviderSetting[] = [...runtimeProviders, "auto"];
const agenticProviders: RuntimeProviderName[] = [...runtimeProviders];
const runtimeSearchProviders: RuntimeSearchProvider[] = ["brave", "exa", "duckduckgo"];
const distillationPriorityTargetKinds = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
] as const;
type DistillationPriorityTargetKind = (typeof distillationPriorityTargetKinds)[number];

function parseIntegerInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function millisecondsToSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number((value / 1000).toFixed(3));
}

function parseSecondsToMillisecondsInput(value: string, fallbackMs: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : fallbackMs;
}

type FallbackSelectValue = RuntimeProviderName | "";

function normalizeFallbackProviders(
  values: Array<FallbackSelectValue | undefined>,
): RuntimeProviderName[] {
  const deduped = new Set<RuntimeProviderName>();
  for (const value of values) {
    if (!value) continue;
    deduped.add(value);
    if (deduped.size >= 2) break;
  }
  return [...deduped];
}

function toFallbackSlots(
  fallback: RuntimeProviderName[],
): [FallbackSelectValue, FallbackSelectValue] {
  const normalized = normalizeFallbackProviders(fallback);
  return [normalized[0] ?? "", normalized[1] ?? ""];
}

function patchFallbackSlot(
  fallback: RuntimeProviderName[],
  slotIndex: 0 | 1,
  value: FallbackSelectValue,
): RuntimeProviderName[] {
  const nextSlots = toFallbackSlots(fallback);
  nextSlots[slotIndex] = value;
  return normalizeFallbackProviders(nextSlots);
}

function normalizeAzureDeploymentSlots(values: number[] | undefined): number[] {
  if (!values || values.length === 0) return [];
  const deduped = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1) continue;
    deduped.add(value);
  }
  return [...deduped];
}

function getConfiguredModelByProvider(
  settings: RuntimeSettingsEditable,
): Record<RuntimeProviderName, string> {
  return {
    openai: settings.providers.openai.model.trim(),
    "azure-openai":
      settings.providers["azure-openai"].deployments
        .find((deployment) => deployment.model.trim())
        ?.model.trim() ?? settings.providers["azure-openai"].model.trim(),
    bedrock: settings.providers.bedrock.model.trim(),
    "local-llm": settings.providers["local-llm"].model.trim(),
    codex: settings.providers.codex?.model?.trim() ?? "codex-sdk-agent",
  };
}

function resolveConfiguredRouteModel(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderSetting,
): string | undefined {
  const modelByProvider = getConfiguredModelByProvider(settings);
  if (provider === "auto") return undefined;
  const model = modelByProvider[provider];
  return model ? model : undefined;
}

type LocalLlmRouteOption = {
  value: string;
  label: string;
  model: string;
  apiBaseUrl: string;
  apiPath: string;
};

type AzureOpenAiRouteOption = {
  value: string;
  label: string;
  slot: number;
  model: string;
  apiBaseUrl: string;
};

function azureRouteOptionLabel(
  deployment: RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"][number],
  index: number,
): string {
  const name = deployment.name.trim() || `Deployment ${index + 1}`;
  const model = deployment.model.trim();
  const endpoint = deployment.apiBaseUrl.trim();
  return [name, model && model !== name ? model : "", endpoint].filter(Boolean).join(" / ");
}

function azureOpenAiRouteOptions(settings: RuntimeSettingsEditable): AzureOpenAiRouteOption[] {
  return settings.providers["azure-openai"].deployments
    .map((deployment, index) => ({
      value: String(index + 1),
      label: azureRouteOptionLabel(deployment, index),
      slot: index + 1,
      model: deployment.model.trim(),
      apiBaseUrl: deployment.apiBaseUrl.trim().replace(/\/+$/, ""),
    }))
    .filter((option) => option.model && option.apiBaseUrl);
}

function normalizeSelectedAzureRouteValue(
  settings: RuntimeSettingsEditable,
  slots: number[] | undefined,
): string {
  const options = azureOpenAiRouteOptions(settings);
  const firstSlot = normalizeAzureDeploymentSlots(slots)[0];
  if (firstSlot && options.some((option) => option.slot === firstSlot)) return String(firstSlot);
  return options[0]?.value ?? "";
}

function azureDeploymentSlotsFromValue(value: string): number[] | undefined {
  const slot = Number(value);
  return Number.isInteger(slot) && slot > 0 ? [slot] : undefined;
}

function selectedAzureRouteOption(
  settings: RuntimeSettingsEditable,
  slots: number[] | undefined,
): AzureOpenAiRouteOption | undefined {
  const selected = normalizeSelectedAzureRouteValue(settings, slots);
  return azureOpenAiRouteOptions(settings).find((option) => option.value === selected);
}

function localLlmRouteTargetValue(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
): string {
  return JSON.stringify({
    apiBaseUrl: model.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: model.apiPath.trim() || "/v1/chat/completions",
    model: model.model.trim(),
  });
}

function parseLocalLlmRouteTarget(
  value: string | undefined,
): { apiBaseUrl: string; apiPath?: string; model: string } | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<{
      apiBaseUrl: string;
      apiPath: string;
      model: string;
    }>;
    if (typeof parsed.apiBaseUrl === "string" && typeof parsed.model === "string") {
      const apiBaseUrl = parsed.apiBaseUrl.trim().replace(/\/+$/, "");
      const apiPath =
        typeof parsed.apiPath === "string" && parsed.apiPath.trim()
          ? parsed.apiPath.trim()
          : undefined;
      const model = parsed.model.trim();
      if (apiBaseUrl && model) return { apiBaseUrl, apiPath, model };
    }
  } catch {
    // Legacy route values are plain model names.
  }
  return null;
}

function localLlmRouteOptionLabel(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
  duplicateModelName = false,
): string {
  const name = model.name.trim();
  const modelName = model.model.trim();
  const endpoint = model.apiBaseUrl.trim();
  return [
    name || modelName,
    modelName && name !== modelName ? modelName : "",
    duplicateModelName || endpoint ? endpoint : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

function localLlmRouteModelOptions(settings: RuntimeSettingsEditable): LocalLlmRouteOption[] {
  const models = settings.providers["local-llm"].models
    .filter((item) => item.model.trim())
    .map((item) => ({
      ...item,
      apiBaseUrl: item.apiBaseUrl.trim().replace(/\/+$/, ""),
      apiPath: item.apiPath.trim() || "/v1/chat/completions",
      model: item.model.trim(),
    }));
  const modelCounts = new Map<string, number>();
  for (const model of models) {
    modelCounts.set(model.model, (modelCounts.get(model.model) ?? 0) + 1);
  }
  return models.map((model) => {
    const duplicateModelName = (modelCounts.get(model.model) ?? 0) > 1;
    return {
      value: duplicateModelName ? localLlmRouteTargetValue(model) : model.model,
      label: localLlmRouteOptionLabel(model, duplicateModelName),
      model: model.model,
      apiBaseUrl: model.apiBaseUrl,
      apiPath: model.apiPath,
    };
  });
}

function resolveConfiguredLocalLlmModel(settings: RuntimeSettingsEditable): string | undefined {
  return (
    localLlmRouteModelOptions(settings)[0]?.value ??
    resolveConfiguredRouteModel(settings, "local-llm")
  );
}

function normalizeSelectedLocalLlmRouteValue(
  settings: RuntimeSettingsEditable,
  value: string | undefined,
): string {
  const options = localLlmRouteModelOptions(settings);
  if (!value?.trim()) return options[0]?.value ?? "";
  if (options.some((option) => option.value === value)) return value;
  const target = parseLocalLlmRouteTarget(value);
  if (target) {
    return (
      options.find(
        (option) =>
          option.apiBaseUrl === target.apiBaseUrl &&
          (!target.apiPath || option.apiPath === target.apiPath) &&
          option.model === target.model,
      )?.value ??
      options[0]?.value ??
      ""
    );
  }
  return options.find((option) => option.model === value.trim())?.value ?? options[0]?.value ?? "";
}

function providerNameOptionLabel(provider: RuntimeProviderSetting): string {
  return provider;
}

function localLlmRouteValueLabel(
  settings: RuntimeSettingsEditable,
  value: string | undefined,
): string {
  const normalized = normalizeSelectedLocalLlmRouteValue(settings, value);
  return (
    localLlmRouteModelOptions(settings).find((option) => option.value === normalized)?.label ??
    value ??
    "not configured"
  );
}

function routeTargetSummary(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
  provider: RuntimeProviderName | RuntimeProviderSetting,
  primary: boolean,
): string {
  if (provider === "auto") return "auto provider order";
  if (provider === "local-llm") {
    return `local-llm / ${localLlmRouteValueLabel(
      settings,
      primary ? route.model : route.localLlmModel,
    )}`;
  }
  if (provider === "azure-openai") {
    const selected = selectedAzureRouteOption(settings, route.azureDeploymentSlots);
    return `azure-openai / ${selected?.label ?? route.model ?? "not configured"}`;
  }
  const model = primary ? route.model : resolveConfiguredRouteModel(settings, provider);
  return `${provider}${model ? ` / ${model}` : ""}`;
}

function resolveActiveSettingsTab(pathname: string): SettingsTabId {
  const match = pathname.match(/^\/(?:setting|settings)\/([^/]+)\/?$/);
  if (!match) return "providers";
  const slug = match[1];
  if (slug === "distillation-runtime") return "taskRouting";
  const found = settingsTabs.find((tab) => tab.path === slug);
  return found?.id ?? "providers";
}

function createEmptySecretDraftState(): SecretDraftState {
  return {
    openaiApiKey: { value: "", clear: false },
    azureOpenAiApiKey: { value: "", clear: false },
    azureOpenAiApiKey2: { value: "", clear: false },
    azureOpenAiApiKey3: { value: "", clear: false },
    localLlmApiKey: { value: "", clear: false },
    braveApiKey: { value: "", clear: false },
    exaApiKey: { value: "", clear: false },
  };
}

function normalizeAzureDeploymentsForForm(
  provider: RuntimeSettingsView["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"] {
  const deployments = provider.deployments.length
    ? provider.deployments
    : [
        {
          name: "Primary",
          apiBaseUrl: provider.apiBaseUrl,
          apiPath: provider.apiPath,
          apiVersion: provider.apiVersion,
          model: provider.model,
        },
      ];
  return deployments.map((deployment, index) => ({
    name: deployment?.name || (index === 0 ? "Primary" : `Deployment ${index + 1}`),
    apiBaseUrl: deployment?.apiBaseUrl ?? (index === 0 ? provider.apiBaseUrl : ""),
    apiPath: deployment?.apiPath || provider.apiPath || "/openai/deployments",
    apiVersion: deployment?.apiVersion || provider.apiVersion || "2025-04-01-preview",
    model: deployment?.model ?? (index === 0 ? provider.model : ""),
  }));
}

function syncAzureOpenAiProviderForDraft(
  provider: RuntimeSettingsEditable["providers"]["azure-openai"],
  deployments: RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"],
): RuntimeSettingsEditable["providers"]["azure-openai"] {
  const primary = deployments[0];
  return {
    ...provider,
    apiBaseUrl: primary?.apiBaseUrl ?? provider.apiBaseUrl,
    apiPath: primary?.apiPath ?? provider.apiPath,
    apiVersion: primary?.apiVersion ?? provider.apiVersion,
    model: primary?.model ?? provider.model,
    deployments,
  };
}

function normalizeLocalLlmModelsForForm(
  provider: RuntimeSettingsView["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"]["models"] {
  const models = provider.models?.length
    ? provider.models
    : [
        {
          name: "Primary",
          apiBaseUrl: provider.apiBaseUrl,
          apiPath: provider.apiPath || "/v1/chat/completions",
          model: provider.model,
        },
      ];
  return models.map((model, index) => ({
    name: model.name || (index === 0 ? "Primary" : `Local LLM ${index + 1}`),
    apiBaseUrl: model.apiBaseUrl ?? (index === 0 ? provider.apiBaseUrl : ""),
    apiPath: model.apiPath || provider.apiPath || "/v1/chat/completions",
    model: model.model ?? (index === 0 ? provider.model : ""),
  }));
}

function syncLocalLlmProviderForDraft(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
  models: RuntimeSettingsEditable["providers"]["local-llm"]["models"],
): RuntimeSettingsEditable["providers"]["local-llm"] {
  const nextModels = models;
  const primary = nextModels[0];
  return {
    ...provider,
    apiBaseUrl: primary?.apiBaseUrl ?? provider.apiBaseUrl,
    apiPath: primary?.apiPath ?? provider.apiPath,
    model: primary?.model ?? provider.model,
    models: nextModels,
  };
}

function normalizeLocalLlmModelsForSave(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"]["models"] {
  return provider.models
    .map((model, index) => ({
      name: model.name.trim() || (index === 0 ? "Primary" : `Local LLM ${index + 1}`),
      apiBaseUrl: model.apiBaseUrl.trim(),
      apiPath: model.apiPath.trim() || "/v1/chat/completions",
      model: model.model.trim(),
    }))
    .filter((model) => model.apiBaseUrl && model.model);
}

function prepareSettingsForSave(settings: RuntimeSettingsEditable): RuntimeSettingsEditable {
  const localLlmModels = normalizeLocalLlmModelsForSave(settings.providers["local-llm"]);
  return {
    ...settings,
    providers: {
      ...settings.providers,
      "local-llm": syncLocalLlmProviderForDraft(settings.providers["local-llm"], localLlmModels),
    },
  };
}

function buildSecretPayload(
  secretDrafts: SecretDraftState,
): Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>> | undefined {
  const result: Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>> = {};
  for (const key of Object.keys(secretDrafts) as RuntimeSecretKey[]) {
    const item = secretDrafts[key];
    if (!item) continue;
    const value = item.value.trim();
    if (item.clear) {
      result[key] = { clear: true };
      continue;
    }
    if (value) {
      result[key] = { value };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function settingsViewToEditable(view: RuntimeSettingsView): RuntimeSettingsEditable {
  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: [...view.general.distillationPriority.targetPriorityOrder],
      },
    },
    providers: {
      openai: {
        enabled: view.providers.openai.enabled,
        apiBaseUrl: view.providers.openai.apiBaseUrl,
        model: view.providers.openai.model,
      },
      "azure-openai": {
        enabled: view.providers["azure-openai"].enabled,
        apiBaseUrl: view.providers["azure-openai"].apiBaseUrl,
        apiPath: view.providers["azure-openai"].apiPath,
        apiVersion: view.providers["azure-openai"].apiVersion,
        model: view.providers["azure-openai"].model,
        deployments: normalizeAzureDeploymentsForForm(view.providers["azure-openai"]),
      },
      bedrock: {
        enabled: view.providers.bedrock.enabled,
        region: view.providers.bedrock.region,
        profile: view.providers.bedrock.profile,
        model: view.providers.bedrock.model,
      },
      "local-llm": {
        enabled: view.providers["local-llm"].enabled,
        apiBaseUrl: view.providers["local-llm"].apiBaseUrl,
        apiPath: view.providers["local-llm"].apiPath,
        model: view.providers["local-llm"].model,
        models: normalizeLocalLlmModelsForForm(view.providers["local-llm"]),
      },
      codex: {
        enabled: view.providers.codex?.enabled ?? false,
        model: view.providers.codex?.model ?? "codex-sdk-agent",
      },
    },
    taskRouting: {
      findCandidate: {
        source: {
          provider: view.taskRouting.findCandidate.source.provider,
          model: view.taskRouting.findCandidate.source.model,
          localLlmModel: view.taskRouting.findCandidate.source.localLlmModel,
          fallback: [...view.taskRouting.findCandidate.source.fallback],
          azureDeploymentSlots: view.taskRouting.findCandidate.source.azureDeploymentSlots
            ? [...view.taskRouting.findCandidate.source.azureDeploymentSlots]
            : undefined,
        },
        vibe: {
          provider: view.taskRouting.findCandidate.vibe.provider,
          model: view.taskRouting.findCandidate.vibe.model,
          localLlmModel: view.taskRouting.findCandidate.vibe.localLlmModel,
          fallback: [...view.taskRouting.findCandidate.vibe.fallback],
          azureDeploymentSlots: view.taskRouting.findCandidate.vibe.azureDeploymentSlots
            ? [...view.taskRouting.findCandidate.vibe.azureDeploymentSlots]
            : undefined,
        },
        throttling: {
          backgroundEnabled: view.taskRouting.findCandidate.throttling.backgroundEnabled,
          interactiveWindowSeconds:
            view.taskRouting.findCandidate.throttling.interactiveWindowSeconds,
          recentBlockSeconds: view.taskRouting.findCandidate.throttling.recentBlockSeconds,
          minIntervalSeconds: view.taskRouting.findCandidate.throttling.minIntervalSeconds,
          mediumIntervalSeconds: view.taskRouting.findCandidate.throttling.mediumIntervalSeconds,
          busyIntervalSeconds: view.taskRouting.findCandidate.throttling.busyIntervalSeconds,
          maxIntervalSeconds: view.taskRouting.findCandidate.throttling.maxIntervalSeconds,
          rateLimitCooldownSeconds:
            view.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds,
          jitterSeconds: view.taskRouting.findCandidate.throttling.jitterSeconds,
        },
      },
      webSourceResearch: {
        provider: view.taskRouting.webSourceResearch.provider,
        model: view.taskRouting.webSourceResearch.model,
        localLlmModel: view.taskRouting.webSourceResearch.localLlmModel,
        fallback: [...view.taskRouting.webSourceResearch.fallback],
        azureDeploymentSlots: view.taskRouting.webSourceResearch.azureDeploymentSlots
          ? [...view.taskRouting.webSourceResearch.azureDeploymentSlots]
          : undefined,
      },
      coverEvidence: {
        sourceSupport: {
          provider: view.taskRouting.coverEvidence.sourceSupport.provider,
          model: view.taskRouting.coverEvidence.sourceSupport.model,
          localLlmModel: view.taskRouting.coverEvidence.sourceSupport.localLlmModel,
          fallback: [...view.taskRouting.coverEvidence.sourceSupport.fallback],
          azureDeploymentSlots: view.taskRouting.coverEvidence.sourceSupport.azureDeploymentSlots
            ? [...view.taskRouting.coverEvidence.sourceSupport.azureDeploymentSlots]
            : undefined,
        },
        externalEvidence: {
          provider: view.taskRouting.coverEvidence.externalEvidence.provider,
          model: view.taskRouting.coverEvidence.externalEvidence.model,
          localLlmModel: view.taskRouting.coverEvidence.externalEvidence.localLlmModel,
          fallback: [...view.taskRouting.coverEvidence.externalEvidence.fallback],
          azureDeploymentSlots: view.taskRouting.coverEvidence.externalEvidence.azureDeploymentSlots
            ? [...view.taskRouting.coverEvidence.externalEvidence.azureDeploymentSlots]
            : undefined,
        },
        mcpEvidence: {
          provider: view.taskRouting.coverEvidence.mcpEvidence.provider,
          model: view.taskRouting.coverEvidence.mcpEvidence.model,
          localLlmModel: view.taskRouting.coverEvidence.mcpEvidence.localLlmModel,
          fallback: [...view.taskRouting.coverEvidence.mcpEvidence.fallback],
          azureDeploymentSlots: view.taskRouting.coverEvidence.mcpEvidence.azureDeploymentSlots
            ? [...view.taskRouting.coverEvidence.mcpEvidence.azureDeploymentSlots]
            : undefined,
        },
      },
      finalizeDistille: {
        provider: view.taskRouting.finalizeDistille.provider,
        model: view.taskRouting.finalizeDistille.model,
        localLlmModel: view.taskRouting.finalizeDistille.localLlmModel,
        fallback: [...view.taskRouting.finalizeDistille.fallback],
        azureDeploymentSlots: view.taskRouting.finalizeDistille.azureDeploymentSlots
          ? [...view.taskRouting.finalizeDistille.azureDeploymentSlots]
          : undefined,
      },
      deadZoneMergeReview: {
        provider: view.taskRouting.deadZoneMergeReview.provider,
        model: view.taskRouting.deadZoneMergeReview.model,
        localLlmModel: view.taskRouting.deadZoneMergeReview.localLlmModel,
        fallback: [...view.taskRouting.deadZoneMergeReview.fallback],
        azureDeploymentSlots: view.taskRouting.deadZoneMergeReview.azureDeploymentSlots
          ? [...view.taskRouting.deadZoneMergeReview.azureDeploymentSlots]
          : undefined,
      },
      agenticCompile: {
        enabled: view.taskRouting.agenticCompile.enabled,
        provider: view.taskRouting.agenticCompile.provider,
        model: view.taskRouting.agenticCompile.model,
        localLlmModel: view.taskRouting.agenticCompile.localLlmModel,
        fallback: [...view.taskRouting.agenticCompile.fallback],
        azureDeploymentSlots: view.taskRouting.agenticCompile.azureDeploymentSlots
          ? [...view.taskRouting.agenticCompile.azureDeploymentSlots]
          : undefined,
        timeoutMs: view.taskRouting.agenticCompile.timeoutMs,
        maxTokens: view.taskRouting.agenticCompile.maxTokens,
      },
    },
    search: {
      providerOrder: [...view.search.providerOrder],
      maxProviderAttempts: view.search.maxProviderAttempts,
      resultCount: view.search.resultCount,
      timeoutMs: view.search.timeoutMs,
      rateLimitCooldownSeconds: view.search.rateLimitCooldownSeconds,
      providers: {
        brave: { enabled: view.search.providers.brave.enabled },
        exa: { enabled: view.search.providers.exa.enabled },
        duckduckgo: { enabled: view.search.providers.duckduckgo.enabled },
      },
    },
    embedding: {
      provider: view.embedding.provider,
      daemonUrl: view.embedding.daemonUrl,
      openaiModel: view.embedding.openaiModel,
      timeoutMs: view.embedding.timeoutMs,
    },
    distillationRuntime: {
      timeoutMs: view.distillationRuntime.timeoutMs,
      candidateTimeoutMs: view.distillationRuntime.candidateTimeoutMs,
      maxToolRounds: view.distillationRuntime.maxToolRounds,
      findCandidateTimeoutMs: view.distillationRuntime.findCandidateTimeoutMs,
      findCandidateMaxToolCalls: view.distillationRuntime.findCandidateMaxToolCalls,
      coverEvidenceTimeoutMs: view.distillationRuntime.coverEvidenceTimeoutMs,
      coverEvidenceSearchMaxCalls: view.distillationRuntime.coverEvidenceSearchMaxCalls,
      coverEvidenceFetchMaxCalls: view.distillationRuntime.coverEvidenceFetchMaxCalls,
      toolTimeoutMs: view.distillationRuntime.toolTimeoutMs,
      toolResultMaxChars: view.distillationRuntime.toolResultMaxChars,
      failureRetryDelaySeconds: view.distillationRuntime.failureRetryDelaySeconds,
      readerMaxReads: view.distillationRuntime.readerMaxReads,
      readerMaxCharsPerRead: view.distillationRuntime.readerMaxCharsPerRead,
      lowImportanceRejectThreshold: view.distillationRuntime.lowImportanceRejectThreshold,
    },
    advanced: {
      pipelineLockStaleSeconds: view.advanced.pipelineLockStaleSeconds,
      lockTtlSeconds: view.advanced.lockTtlSeconds,
      pipelineClaimLimit: view.advanced.pipelineClaimLimit,
      findingQueueTaskIntervalSeconds: view.advanced.findingQueueTaskIntervalSeconds,
      coveringQueueTaskIntervalSeconds: view.advanced.coveringQueueTaskIntervalSeconds,
      continuousIdleSleepMs: view.advanced.continuousIdleSleepMs,
      continuousErrorSleepMs: view.advanced.continuousErrorSleepMs,
      inventoryRefreshIntervalMs: view.advanced.inventoryRefreshIntervalMs,
      doctorFreshnessThresholdMinutes: view.advanced.doctorFreshnessThresholdMinutes,
      doctorDegradedRateThreshold: view.advanced.doctorDegradedRateThreshold,
      doctorKnowledgeZeroUseWarningMinActiveCount:
        view.advanced.doctorKnowledgeZeroUseWarningMinActiveCount,
      codexLogSyncEnabled: view.advanced.codexLogSyncEnabled,
      antigravityLogSyncEnabled: view.advanced.antigravityLogSyncEnabled,
      claudeLogSyncEnabled: view.advanced.claudeLogSyncEnabled,
    },
  };
}

function SecretStatusBadge({ status }: { status: RuntimeSecretStatus }) {
  if (!status.configured) return <Badge variant="outline">unset</Badge>;
  if (status.source === "db") return <Badge variant="success">db</Badge>;
  if (status.source === "env") return <Badge variant="secondary">env</Badge>;
  if (status.source === "env-or-profile") return <Badge variant="secondary">env/profile</Badge>;
  return <Badge variant="outline">{status.source}</Badge>;
}

function ProviderHealthBadge({ health }: { health: RuntimeProviderHealth | undefined }) {
  if (!health) return <Badge variant="outline">not tested</Badge>;
  if (!health.configured) return <Badge variant="warning">unconfigured</Badge>;
  if (health.reachable) return <Badge variant="success">reachable</Badge>;
  return <Badge variant="destructive">unreachable</Badge>;
}

function RouteEditor({
  label,
  description,
  settings,
  route,
  onChange,
  providerOptions = runtimeProviderOptions,
}: {
  label: string;
  description: string;
  settings: RuntimeSettingsEditable;
  route: RuntimeSettingsRoute;
  onChange: (next: RuntimeSettingsRoute) => void;
  providerOptions?: RuntimeProviderSetting[];
}) {
  const fallbackSlots = toFallbackSlots(route.fallback);
  const localModelOptions = localLlmRouteModelOptions(settings);
  const azureModelOptions = azureOpenAiRouteOptions(settings);
  const usesLocalLlm = route.provider === "local-llm" || route.fallback.includes("local-llm");
  const usesAzureOpenAi =
    route.provider === "azure-openai" || route.fallback.includes("azure-openai");
  const selectedLocalLlmModel =
    route.provider === "local-llm"
      ? normalizeSelectedLocalLlmRouteValue(settings, route.model)
      : normalizeSelectedLocalLlmRouteValue(
          settings,
          route.localLlmModel ?? resolveConfiguredLocalLlmModel(settings),
        );
  const selectedAzureDeployment = normalizeSelectedAzureRouteValue(
    settings,
    route.azureDeploymentSlots,
  );
  const routeChain = [
    { label: "Primary", value: routeTargetSummary(settings, route, route.provider, true) },
    ...route.fallback.map((provider, index) => ({
      label: `Fallback ${index + 1}`,
      value: routeTargetSummary(settings, route, provider, false),
    })),
  ];

  return (
    <div className="settings-route-row">
      <div className="settings-route-header">
        <div className="settings-route-label">{label}</div>
        <p className="settings-route-description">{description}</p>
      </div>
      <div className="settings-route-fields settings-route-fields-routing">
        <label className="settings-field">
          <span>Provider</span>
          <Select
            value={route.provider}
            onChange={(event) => {
              const provider = event.target.value as RuntimeProviderSetting;
              const azureOption = selectedAzureRouteOption(settings, route.azureDeploymentSlots);
              onChange({
                ...route,
                provider,
                model:
                  provider === "azure-openai"
                    ? (azureOption?.model ?? resolveConfiguredRouteModel(settings, provider))
                    : resolveConfiguredRouteModel(settings, provider),
                localLlmModel:
                  provider === "local-llm" || route.fallback.includes("local-llm")
                    ? (route.localLlmModel ?? resolveConfiguredLocalLlmModel(settings))
                    : undefined,
                azureDeploymentSlots:
                  provider === "azure-openai" || route.fallback.includes("azure-openai")
                    ? (route.azureDeploymentSlots ??
                      azureDeploymentSlotsFromValue(
                        normalizeSelectedAzureRouteValue(settings, route.azureDeploymentSlots),
                      ))
                    : undefined,
              });
            }}
          >
            {providerOptions.map((provider) => (
              <option key={provider} value={provider}>
                {providerNameOptionLabel(provider)}
              </option>
            ))}
          </Select>
        </label>
        {usesLocalLlm ? (
          <label className="settings-field">
            <span>Local LLM API</span>
            <Select
              value={selectedLocalLlmModel}
              onChange={(event) =>
                onChange({
                  ...route,
                  ...(route.provider === "local-llm"
                    ? {
                        model:
                          event.target.value ||
                          resolveConfiguredRouteModel(settings, route.provider),
                        localLlmModel:
                          event.target.value || resolveConfiguredLocalLlmModel(settings),
                      }
                    : {
                        localLlmModel:
                          event.target.value || resolveConfiguredLocalLlmModel(settings),
                      }),
                })
              }
            >
              {localModelOptions.length === 0 ? (
                <option value="">not configured</option>
              ) : (
                localModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              )}
            </Select>
          </label>
        ) : null}
        {route.fallback.includes("local-llm") && route.provider !== "local-llm" ? (
          <span className="settings-field-hint">
            Local LLM fallback uses the selected Local LLM API/model.
          </span>
        ) : null}
        <label className="settings-field">
          <span>Fallback 1</span>
          <Select
            value={fallbackSlots[0]}
            onChange={(event) => {
              const fallback = patchFallbackSlot(
                route.fallback,
                0,
                event.target.value as FallbackSelectValue,
              );
              const azureOption = selectedAzureRouteOption(settings, route.azureDeploymentSlots);
              onChange({
                ...route,
                fallback,
                localLlmModel:
                  route.provider === "local-llm" || fallback.includes("local-llm")
                    ? (route.localLlmModel ?? resolveConfiguredLocalLlmModel(settings))
                    : undefined,
                azureDeploymentSlots:
                  route.provider === "azure-openai" || fallback.includes("azure-openai")
                    ? (route.azureDeploymentSlots ??
                      azureDeploymentSlotsFromValue(
                        normalizeSelectedAzureRouteValue(settings, route.azureDeploymentSlots),
                      ))
                    : undefined,
                model:
                  route.provider === "azure-openai" && azureOption
                    ? azureOption.model
                    : route.model,
              });
            }}
          >
            <option value="">none</option>
            {runtimeProviders.map((provider) => (
              <option key={provider} value={provider}>
                {providerNameOptionLabel(provider)}
              </option>
            ))}
          </Select>
        </label>
        <label className="settings-field">
          <span>Fallback 2</span>
          <Select
            value={fallbackSlots[1]}
            onChange={(event) => {
              const fallback = patchFallbackSlot(
                route.fallback,
                1,
                event.target.value as FallbackSelectValue,
              );
              const azureOption = selectedAzureRouteOption(settings, route.azureDeploymentSlots);
              onChange({
                ...route,
                fallback,
                localLlmModel:
                  route.provider === "local-llm" || fallback.includes("local-llm")
                    ? (route.localLlmModel ?? resolveConfiguredLocalLlmModel(settings))
                    : undefined,
                azureDeploymentSlots:
                  route.provider === "azure-openai" || fallback.includes("azure-openai")
                    ? (route.azureDeploymentSlots ??
                      azureDeploymentSlotsFromValue(
                        normalizeSelectedAzureRouteValue(settings, route.azureDeploymentSlots),
                      ))
                    : undefined,
                model:
                  route.provider === "azure-openai" && azureOption
                    ? azureOption.model
                    : route.model,
              });
            }}
          >
            <option value="">none</option>
            {runtimeProviders.map((provider) => (
              <option key={provider} value={provider}>
                {providerNameOptionLabel(provider)}
              </option>
            ))}
          </Select>
        </label>
        {usesAzureOpenAi ? (
          <label className="settings-field">
            <span>Azure OpenAI API</span>
            <Select
              value={selectedAzureDeployment}
              onChange={(event) => {
                const option = azureModelOptions.find((item) => item.value === event.target.value);
                onChange({
                  ...route,
                  azureDeploymentSlots: azureDeploymentSlotsFromValue(event.target.value),
                  model:
                    route.provider === "azure-openai"
                      ? (option?.model ?? route.model)
                      : route.model,
                });
              }}
            >
              {azureModelOptions.length === 0 ? (
                <option value="">not configured</option>
              ) : (
                azureModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              )}
            </Select>
          </label>
        ) : null}
      </div>
      <div className="settings-route-chain" aria-label={`${label} effective route`}>
        {routeChain.map((item) => (
          <span key={`${item.label}:${item.value}`} className="settings-route-chain-item">
            <strong>{item.label}</strong>
            {item.value}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Codex Auth sub-components
// ---------------------------------------------------------------------------

function CodexActionGuide({
  recommendedAction,
  isExpired,
  loginCommand,
  onGetCommand,
  isPending,
  onRefresh,
}: {
  recommendedAction: "ready" | "run-codex-login" | "set-codex-access-token" | "install-codex-cli";
  isExpired: boolean;
  loginCommand: string | null;
  onGetCommand: () => void;
  isPending: boolean;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = loginCommand ?? "codex login";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (recommendedAction === "ready" && !isExpired) {
    return (
      <div className="flex items-center gap-2 rounded bg-success/10 px-3 py-2 text-xs text-success">
        <span>🎉</span>
        <span className="font-semibold">Ready to use Codex as an LLM provider.</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-6 text-xs"
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
    );
  }

  if (recommendedAction === "install-codex-cli") {
    return (
      <div className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
        <p className="font-semibold">Install Codex CLI first:</p>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 rounded bg-background px-2 py-1 font-mono">
            npm install -g @openai/codex
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-xs"
            onClick={() => void navigator.clipboard.writeText("npm install -g @openai/codex")}
          >
            Copy
          </Button>
        </div>
        <p className="mt-2">
          Or configure <code>CODEX_ACCESS_TOKEN</code> in your environment.
        </p>
      </div>
    );
  }

  // run-codex-login or expired
  const cmd = loginCommand ?? "codex login";
  return (
    <div className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
      <p className="font-semibold">
        {isExpired
          ? "Re-authenticate by running in your terminal:"
          : "Authenticate by running in your terminal:"}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {loginCommand ? (
          <code className="flex-1 rounded bg-background px-2 py-1 font-mono">{cmd}</code>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={onGetCommand}
            disabled={isPending}
          >
            {isPending ? "Loading…" : "Get Login Command"}
          </Button>
        )}
        {loginCommand && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-xs"
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-muted-foreground/70">
        After login, click{" "}
        <button type="button" className="underline hover:text-foreground" onClick={onRefresh}>
          Refresh
        </button>{" "}
        to update the status.
      </p>
    </div>
  );
}

export function SettingsPage() {
  const tz = useTimezone();
  const formatDateTime = (value: string | null | undefined): string => {
    return formatDateTimeTz(value, tz);
  };

  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab = useMemo(() => resolveActiveSettingsTab(pathname), [pathname]);
  const [draft, setDraft] = useState<RuntimeSettingsEditable | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<SecretDraftState>(createEmptySecretDraftState());
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<
    Partial<Record<RuntimeProviderName, RuntimeProviderHealth>>
  >({});
  const [azureDeploymentHealth, setAzureDeploymentHealth] = useState<
    Partial<Record<number, RuntimeProviderHealth>>
  >({});
  const [localLlmModelHealth, setLocalLlmModelHealth] = useState<
    Partial<Record<string, RuntimeProviderHealth>>
  >({});

  const settingsQuery = useQuery({
    queryKey: ["runtime-settings"],
    queryFn: () => fetchRuntimeSettings(),
  });

  const codexAuthQuery = useQuery({
    queryKey: ["codex-auth-status"],
    queryFn: () => fetchCodexAuthStatus(),
    enabled: activeTab === "providers",
  });

  const [loginCommand, setLoginCommand] = useState<string | null>(null);

  const getLoginCommandMutation = useMutation({
    mutationFn: () => fetchCodexLoginCommand(),
    onSuccess: (result) => {
      setLoginCommand(result.command);
    },
  });

  const snapshot = settingsQuery.data;
  const sourceView = snapshot?.settings;
  const baseEditable = useMemo(
    () => (sourceView ? settingsViewToEditable(sourceView) : null),
    [sourceView],
  );

  useEffect(() => {
    if (!baseEditable) return;
    setDraft(baseEditable);
    setSecretDrafts(createEmptySecretDraftState());
    setSaveError(null);
    setSaveMessage(null);
    setAzureDeploymentHealth({});
  }, [baseEditable]);

  const hasSettingsDiff = useMemo(() => {
    if (!draft || !baseEditable) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseEditable);
  }, [draft, baseEditable]);
  const hasSecretDiff = useMemo(
    () =>
      (Object.keys(secretDrafts) as RuntimeSecretKey[]).some((key) => {
        const item = secretDrafts[key];
        return Boolean(item?.clear || item?.value.trim().length);
      }),
    [secretDrafts],
  );

  const patchDraft = (
    next: (current: RuntimeSettingsEditable) => RuntimeSettingsEditable,
  ): void => {
    setDraft((current) => (current ? next(current) : current));
  };

  const renderDistillationRuntimeNumberField = ({
    label,
    settingKey,
    min,
    max,
    step,
    parse = parseIntegerInput,
    unit = "raw",
  }: {
    label: string;
    settingKey: keyof RuntimeSettingsEditable["distillationRuntime"];
    min?: number;
    max?: number;
    step?: number;
    parse?: (value: string, fallback: number) => number;
    unit?: "raw" | "secondsFromMilliseconds";
  }) => (
    <label className="settings-field">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={
          unit === "secondsFromMilliseconds"
            ? millisecondsToSeconds(Number(draft?.distillationRuntime[settingKey] ?? 0))
            : (draft?.distillationRuntime[settingKey] ?? 0)
        }
        onChange={(event) =>
          patchDraft((current) => ({
            ...current,
            distillationRuntime: {
              ...current.distillationRuntime,
              [settingKey]:
                unit === "secondsFromMilliseconds"
                  ? parseSecondsToMillisecondsInput(
                      event.target.value,
                      Number(current.distillationRuntime[settingKey]),
                    )
                  : parse(event.target.value, current.distillationRuntime[settingKey]),
            },
          }))
        }
      />
    </label>
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("settings are not loaded");
      return updateRuntimeSettings({
        settings: prepareSettingsForSave(draft),
        secrets: buildSecretPayload(secretDrafts),
        updatedBy: "admin-ui",
      });
    },
    onSuccess: async (result) => {
      setSaveError(null);
      setSaveMessage(`Saved revision ${result.revision} at ${formatDateTime(result.updatedAt)}.`);
      setSecretDrafts(createEmptySecretDraftState());
      await queryClient.invalidateQueries({ queryKey: ["runtime-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  const reloadMutation = useMutation({
    mutationFn: () => reloadRuntimeSettingsCache(),
    onSuccess: async (result) => {
      setSaveError(null);
      setSaveMessage(`Runtime cache reloaded at ${formatDateTime(result.reloadedAt)}.`);
      await queryClient.invalidateQueries({ queryKey: ["runtime-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  const providerTestMutation = useMutation({
    mutationFn: (provider: RuntimeProviderName) => testRuntimeProvider(provider),
    onSuccess: (result) => {
      setProviderHealth((current) => ({
        ...current,
        [result.provider]: result.health,
      }));
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  const azureDeploymentTestMutation = useMutation({
    mutationFn: (deploymentIndex: number) => testAzureOpenAiDeployment(deploymentIndex),
    onSuccess: (result, deploymentIndex) => {
      setAzureDeploymentHealth((current) => ({
        ...current,
        [deploymentIndex]: result.health,
      }));
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  const localLlmModelTestMutation = useMutation({
    mutationFn: (model: string) => testLocalLlmModel(model),
    onSuccess: (result) => {
      setLocalLlmModelHealth((current) => ({
        ...current,
        [result.model]: result.health,
      }));
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  const setSecretValue = (key: RuntimeSecretKey, value: string): void => {
    setSecretDrafts((current) => ({
      ...current,
      [key]: { value, clear: false },
    }));
  };

  const markSecretClear = (key: RuntimeSecretKey): void => {
    setSecretDrafts((current) => ({
      ...current,
      [key]: { value: "", clear: true },
    }));
  };

  const markSecretReplace = (key: RuntimeSecretKey): void => {
    setSecretDrafts((current) => ({
      ...current,
      [key]: { value: current[key]?.value ?? "", clear: false },
    }));
  };

  const renderSecretEditor = (
    key: RuntimeSecretKey,
    label: string,
    status: RuntimeSecretStatus,
  ) => {
    const draftSecret = secretDrafts[key] ?? { value: "", clear: false };
    return (
      <div className="settings-secret-row">
        <div className="settings-secret-meta">
          <strong>{label}</strong>
          <div className="settings-secret-status">
            <SecretStatusBadge status={status} />
            <span>{status.maskedValue ?? "not configured"}</span>
            <span>updated {formatDateTime(status.updatedAt)}</span>
          </div>
        </div>
        <div className="settings-secret-inputs">
          <Input
            type="password"
            aria-label={`${label} value`}
            value={draftSecret.value}
            placeholder="new value"
            onChange={(event) => setSecretValue(key, event.target.value)}
          />
          <Button type="button" size="sm" variant="outline" onClick={() => markSecretReplace(key)}>
            <Save size={14} />
            Replace
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => markSecretClear(key)}
          >
            <Trash2 size={14} />
            Clear
          </Button>
          {draftSecret.clear ? <Badge variant="destructive">pending clear</Badge> : null}
          {draftSecret.value.trim() ? <Badge variant="warning">pending replace</Badge> : null}
        </div>
      </div>
    );
  };

  const moveSearchProvider = (provider: RuntimeSearchProvider, direction: -1 | 1): void => {
    patchDraft((current) => {
      const order = [...current.search.providerOrder];
      const index = order.indexOf(provider);
      if (index < 0) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= order.length) return current;
      const swap = order[nextIndex];
      order[nextIndex] = order[index];
      order[index] = swap;
      return {
        ...current,
        search: {
          ...current.search,
          providerOrder: order,
        },
      };
    });
  };

  const movePriorityTargetKind = (
    kind: DistillationPriorityTargetKind,
    direction: -1 | 1,
  ): void => {
    patchDraft((current) => {
      const order = [...current.general.distillationPriority.targetPriorityOrder];
      const index = order.indexOf(kind);
      if (index < 0) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= order.length) return current;
      const swap = order[nextIndex];
      order[nextIndex] = order[index];
      order[index] = swap;
      return {
        ...current,
        general: {
          ...current.general,
          distillationPriority: {
            ...current.general.distillationPriority,
            targetPriorityOrder: order,
          },
        },
      };
    });
  };

  const settingsStatus: "ok" | "failed" = settingsQuery.isError || saveError ? "failed" : "ok";

  const renderProviderEndpointsPanel = () => {
    if (!draft) return null;

    const updateAzureDeployment = (
      index: number,
      patch: Partial<RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"][number]>,
    ) =>
      patchDraft((current) => {
        const deployments = current.providers["azure-openai"].deployments.map(
          (deployment, itemIndex) =>
            itemIndex === index ? { ...deployment, ...patch } : deployment,
        );
        return {
          ...current,
          providers: {
            ...current.providers,
            "azure-openai": syncAzureOpenAiProviderForDraft(
              current.providers["azure-openai"],
              deployments,
            ),
          },
        };
      });

    const updateLocalLlmModel = (
      index: number,
      patch: Partial<RuntimeSettingsEditable["providers"]["local-llm"]["models"][number]>,
    ) =>
      patchDraft((current) => {
        const models = current.providers["local-llm"].models.map((model, itemIndex) =>
          itemIndex === index ? { ...model, ...patch } : model,
        );
        return {
          ...current,
          providers: {
            ...current.providers,
            "local-llm": syncLocalLlmProviderForDraft(current.providers["local-llm"], models),
          },
        };
      });

    const addEndpoint = () =>
      patchDraft((current) => {
        const models = current.providers["local-llm"].models;
        const nextIndex = models.length;
        return {
          ...current,
          providers: {
            ...current.providers,
            "local-llm": syncLocalLlmProviderForDraft(current.providers["local-llm"], [
              ...models,
              {
                name: `Local LLM ${nextIndex + 1}`,
                apiBaseUrl: "",
                apiPath: current.providers["local-llm"].apiPath || "/v1/chat/completions",
                model: "",
              },
            ]),
          },
        };
      });

    const convertAzureEndpointToLocal = (index: number) =>
      patchDraft((current) => {
        const deployment = current.providers["azure-openai"].deployments[index];
        if (!deployment) return current;
        return {
          ...current,
          providers: {
            ...current.providers,
            "azure-openai": syncAzureOpenAiProviderForDraft(
              current.providers["azure-openai"],
              current.providers["azure-openai"].deployments.filter(
                (_deployment, deploymentIndex) => deploymentIndex !== index,
              ),
            ),
            "local-llm": syncLocalLlmProviderForDraft(current.providers["local-llm"], [
              ...current.providers["local-llm"].models,
              {
                name:
                  deployment.name ||
                  `Local LLM ${current.providers["local-llm"].models.length + 1}`,
                apiBaseUrl: deployment.apiBaseUrl,
                apiPath: current.providers["local-llm"].apiPath || "/v1/chat/completions",
                model: deployment.model,
              },
            ]),
          },
        };
      });

    const convertLocalEndpointToAzure = (index: number) =>
      patchDraft((current) => {
        const model = current.providers["local-llm"].models[index];
        if (!model) return current;
        return {
          ...current,
          providers: {
            ...current.providers,
            "local-llm": syncLocalLlmProviderForDraft(
              current.providers["local-llm"],
              current.providers["local-llm"].models.filter(
                (_model, modelIndex) => modelIndex !== index,
              ),
            ),
            "azure-openai": syncAzureOpenAiProviderForDraft(current.providers["azure-openai"], [
              ...current.providers["azure-openai"].deployments,
              {
                name:
                  model.name ||
                  `Deployment ${current.providers["azure-openai"].deployments.length + 1}`,
                apiBaseUrl: model.apiBaseUrl,
                apiPath: current.providers["azure-openai"].apiPath || "/openai/deployments",
                apiVersion: current.providers["azure-openai"].apiVersion || "2025-04-01-preview",
                model: model.model,
              },
            ]),
          },
        };
      });

    return (
      <section className="settings-provider-endpoints">
        <div className="settings-provider-endpoints-header">
          <div>
            <h2>Provider Endpoints</h2>
            <p>
              LLM provider endpoints and credentials. Task Routing selects from these endpoints.
            </p>
          </div>
          <div className="settings-provider-endpoints-actions">
            <Button type="button" size="sm" variant="outline" onClick={addEndpoint}>
              <Plus size={14} />
              Add Endpoint
            </Button>
          </div>
        </div>

        <div className="settings-provider-endpoint-list">
          <div className="settings-provider-endpoint-card">
            <div className="settings-provider-endpoint-top">
              <div className="settings-provider-endpoint-title">
                <strong>OpenAI</strong>
                <span>OpenAI</span>
              </div>
              <div className="settings-provider-actions">
                <label className="settings-check">
                  <Checkbox
                    checked={draft.providers.openai.enabled}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          openai: { ...current.providers.openai, enabled: event.target.checked },
                        },
                      }))
                    }
                  />
                  Enabled
                </label>
                <ProviderHealthBadge health={providerHealth.openai} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => providerTestMutation.mutate("openai")}
                  disabled={providerTestMutation.isPending}
                >
                  <Stethoscope size={14} />
                  Health
                </Button>
              </div>
            </div>
            <div className="settings-provider-endpoint-fields">
              <label className="settings-field">
                <span>Name</span>
                <Input value="OpenAI" readOnly />
              </label>
              <label className="settings-field">
                <span>Kind</span>
                <Select value="openai" disabled>
                  <option value="openai">OpenAI</option>
                </Select>
              </label>
              <label className="settings-field">
                <span>Endpoint</span>
                <Input
                  value={draft.providers.openai.apiBaseUrl}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        openai: {
                          ...current.providers.openai,
                          apiBaseUrl: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Models</span>
                <Input
                  value={draft.providers.openai.model}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        openai: { ...current.providers.openai, model: event.target.value },
                      },
                    }))
                  }
                />
              </label>
            </div>
            {sourceView
              ? renderSecretEditor(
                  "openaiApiKey",
                  "API Key",
                  sourceView.providers.openai.apiKeySecret,
                )
              : null}
          </div>

          {draft.providers["azure-openai"].deployments.map((deployment, index) => {
            const secretKey = azureOpenAiSecretKey(index);
            const secretStatus =
              secretKey && sourceView
                ? (sourceView.providers["azure-openai"].apiKeySecrets[index] ??
                  emptyRuntimeSecretStatus())
                : null;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: Endpoint rows are controlled inputs; value-derived keys remount rows while editing.
              <div key={`azure-openai:${index}`} className="settings-provider-endpoint-card">
                <div className="settings-provider-endpoint-top">
                  <div className="settings-provider-endpoint-title">
                    <strong>{deployment.name || `Deployment ${index + 1}`}</strong>
                    <span>Azure OpenAI</span>
                  </div>
                  <div className="settings-provider-actions">
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.providers["azure-openai"].enabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "azure-openai": {
                                ...current.providers["azure-openai"],
                                enabled: event.target.checked,
                              },
                            },
                          }))
                        }
                      />
                      Enabled
                    </label>
                    <ProviderHealthBadge health={azureDeploymentHealth[index]} />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => azureDeploymentTestMutation.mutate(index)}
                      disabled={azureDeploymentTestMutation.isPending}
                    >
                      <Stethoscope size={14} />
                      Health
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        patchDraft((current) => ({
                          ...current,
                          providers: {
                            ...current.providers,
                            "azure-openai": syncAzureOpenAiProviderForDraft(
                              current.providers["azure-openai"],
                              current.providers["azure-openai"].deployments.filter(
                                (_deployment, deploymentIndex) => deploymentIndex !== index,
                              ),
                            ),
                          },
                        }))
                      }
                    >
                      <Trash2 size={14} />
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="settings-provider-endpoint-fields">
                  <label className="settings-field">
                    <span>Name</span>
                    <Input
                      value={deployment.name}
                      onChange={(event) =>
                        updateAzureDeployment(index, { name: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Kind</span>
                    <Select
                      value="azure-openai"
                      onChange={(event) => {
                        if (event.target.value === "local-llm") convertAzureEndpointToLocal(index);
                      }}
                    >
                      <option value="azure-openai">Azure OpenAI</option>
                      <option value="local-llm">Local LLM</option>
                    </Select>
                  </label>
                  <label className="settings-field">
                    <span>Endpoint</span>
                    <Input
                      value={deployment.apiBaseUrl}
                      onChange={(event) =>
                        updateAzureDeployment(index, { apiBaseUrl: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>API Version</span>
                    <Input
                      value={deployment.apiVersion}
                      onChange={(event) =>
                        updateAzureDeployment(index, { apiVersion: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>API Path</span>
                    <Input
                      value={deployment.apiPath}
                      onChange={(event) =>
                        updateAzureDeployment(index, { apiPath: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Models</span>
                    <Input
                      value={deployment.model}
                      onChange={(event) =>
                        updateAzureDeployment(index, { model: event.target.value })
                      }
                    />
                  </label>
                </div>
                {secretKey && secretStatus ? (
                  renderSecretEditor(secretKey, `API Key ${index + 1}`, secretStatus)
                ) : (
                  <div className="settings-secret-row">
                    <div className="settings-secret-meta">
                      <strong>API Key</strong>
                      <div className="settings-secret-status">
                        <span>uses primary Azure OpenAI API key</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {draft.providers["local-llm"].models.map((model, index) => {
            const routeValue = localLlmRouteTargetValue(model);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: Endpoint rows are controlled inputs; value-derived keys remount rows while editing.
                key={`local-llm:${index}`}
                className="settings-provider-endpoint-card settings-local-llm-model"
              >
                <div className="settings-provider-endpoint-top">
                  <div className="settings-provider-endpoint-title">
                    <strong>{model.name || `Local LLM ${index + 1}`}</strong>
                    <span>Local LLM</span>
                  </div>
                  <div className="settings-provider-actions">
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.providers["local-llm"].enabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "local-llm": {
                                ...current.providers["local-llm"],
                                enabled: event.target.checked,
                              },
                            },
                          }))
                        }
                      />
                      Enabled
                    </label>
                    <ProviderHealthBadge health={localLlmModelHealth[routeValue]} />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => localLlmModelTestMutation.mutate(routeValue)}
                      disabled={!model.model.trim() || localLlmModelTestMutation.isPending}
                    >
                      <Stethoscope size={14} />
                      Health
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        patchDraft((current) => ({
                          ...current,
                          providers: {
                            ...current.providers,
                            "local-llm": syncLocalLlmProviderForDraft(
                              current.providers["local-llm"],
                              current.providers["local-llm"].models.filter(
                                (_model, modelIndex) => modelIndex !== index,
                              ),
                            ),
                          },
                        }))
                      }
                    >
                      <Trash2 size={14} />
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="settings-provider-endpoint-fields">
                  <label className="settings-field">
                    <span>Name</span>
                    <Input
                      value={model.name}
                      onChange={(event) => updateLocalLlmModel(index, { name: event.target.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Kind</span>
                    <Select
                      value="local-llm"
                      onChange={(event) => {
                        if (event.target.value === "azure-openai")
                          convertLocalEndpointToAzure(index);
                      }}
                    >
                      <option value="azure-openai">Azure OpenAI</option>
                      <option value="local-llm">Local LLM</option>
                    </Select>
                  </label>
                  <label className="settings-field">
                    <span>Endpoint</span>
                    <Input
                      value={model.apiBaseUrl}
                      onChange={(event) =>
                        updateLocalLlmModel(index, { apiBaseUrl: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>API Path</span>
                    <Input
                      value={model.apiPath}
                      onChange={(event) =>
                        updateLocalLlmModel(index, { apiPath: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Models</span>
                    <Input
                      value={model.model}
                      onChange={(event) =>
                        updateLocalLlmModel(index, { model: event.target.value })
                      }
                    />
                  </label>
                </div>
                {index === 0 && sourceView
                  ? renderSecretEditor(
                      "localLlmApiKey",
                      "API Key",
                      sourceView.providers["local-llm"].apiKeySecret,
                    )
                  : null}
              </div>
            );
          })}

          <div className="settings-provider-endpoint-card">
            <div className="settings-provider-endpoint-top">
              <div className="settings-provider-endpoint-title">
                <strong>AWS Bedrock</strong>
                <span>AWS Bedrock</span>
              </div>
              <div className="settings-provider-actions">
                <label className="settings-check">
                  <Checkbox
                    checked={draft.providers.bedrock.enabled}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          bedrock: { ...current.providers.bedrock, enabled: event.target.checked },
                        },
                      }))
                    }
                  />
                  Enabled
                </label>
                <ProviderHealthBadge health={providerHealth.bedrock} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => providerTestMutation.mutate("bedrock")}
                  disabled={providerTestMutation.isPending}
                >
                  <Stethoscope size={14} />
                  Health
                </Button>
              </div>
            </div>
            <div className="settings-provider-endpoint-fields">
              <label className="settings-field">
                <span>Name</span>
                <Input value="AWS Bedrock" readOnly />
              </label>
              <label className="settings-field">
                <span>Kind</span>
                <Select value="bedrock" disabled>
                  <option value="bedrock">AWS Bedrock</option>
                </Select>
              </label>
              <label className="settings-field">
                <span>Region</span>
                <Input
                  value={draft.providers.bedrock.region}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, region: event.target.value },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Profile</span>
                <Input
                  value={draft.providers.bedrock.profile}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, profile: event.target.value },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Models</span>
                <Input
                  value={draft.providers.bedrock.model}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, model: event.target.value },
                      },
                    }))
                  }
                />
              </label>
            </div>
            {sourceView ? (
              <div className="settings-secret-row">
                <div className="settings-secret-meta">
                  <strong>Credential Status</strong>
                  <div className="settings-secret-status">
                    <SecretStatusBadge status={sourceView.providers.bedrock.credentialSecret} />
                    <span>
                      {sourceView.providers.bedrock.credentialSecret.maskedValue ?? "unset"}
                    </span>
                    <span>
                      updated{" "}
                      {formatDateTime(sourceView.providers.bedrock.credentialSecret.updatedAt)}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="settings-provider-endpoint-card">
            <div className="settings-provider-endpoint-top">
              <div className="settings-provider-endpoint-title">
                <strong>Codex Auth</strong>
                <span>Codex SDK</span>
              </div>
              <div className="settings-provider-actions">
                <label className="settings-check">
                  <Checkbox
                    checked={draft.providers.codex?.enabled ?? false}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          codex: { ...current.providers.codex, enabled: event.target.checked },
                        },
                      }))
                    }
                  />
                  Enabled
                </label>
                {codexAuthQuery.isLoading ? <Badge variant="outline">Checking...</Badge> : null}
                {codexAuthQuery.data ? (
                  <Badge
                    variant={
                      codexAuthQuery.data.recommendedAction === "ready"
                        ? "success"
                        : codexAuthQuery.data.tokenInfo?.isExpired
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {codexAuthQuery.data.recommendedAction === "ready"
                      ? "Logged in"
                      : codexAuthQuery.data.tokenInfo?.isExpired
                        ? "Token expired"
                        : "Login required"}
                  </Badge>
                ) : null}
              </div>
            </div>
            <div className="settings-provider-endpoint-fields">
              <label className="settings-field">
                <span>Name</span>
                <Input value="Codex Auth" readOnly />
              </label>
              <label className="settings-field">
                <span>Kind</span>
                <Select value="codex" disabled>
                  <option value="codex">Codex SDK</option>
                </Select>
              </label>
              <label className="settings-field">
                <span>Models</span>
                <Select
                  value={draft.providers.codex?.model ?? "codex-sdk-agent"}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        codex: { ...current.providers.codex, model: event.target.value },
                      },
                    }))
                  }
                >
                  <option value="codex-sdk-agent">codex-sdk-agent</option>
                  <option value="gpt-5.5">gpt-5.5</option>
                  <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                  <option value="gpt-5.2-codex">gpt-5.2-codex</option>
                </Select>
              </label>
            </div>
            {codexAuthQuery.data ? (
              <CodexActionGuide
                recommendedAction={codexAuthQuery.data.recommendedAction}
                isExpired={codexAuthQuery.data.tokenInfo?.isExpired ?? false}
                loginCommand={loginCommand}
                onGetCommand={() => getLoginCommandMutation.mutate()}
                isPending={getLoginCommandMutation.isPending}
                onRefresh={() => void codexAuthQuery.refetch()}
              />
            ) : null}
          </div>
        </div>
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Settings"
        checkedAtText={formatDateTime(snapshot?.loadedAt)}
        onRefresh={() => {
          void settingsQuery.refetch();
        }}
        refreshDisabled={settingsQuery.isFetching}
        status={settingsStatus}
        rightSlot={
          <div className="settings-header-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => reloadMutation.mutate()}
              disabled={reloadMutation.isPending}
            >
              <RotateCcw size={14} />
              Reload Runtime Cache
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!draft || (!hasSettingsDiff && !hasSecretDiff) || saveMutation.isPending}
            >
              <Save size={14} />
              Save Settings
            </Button>
          </div>
        }
      />

      <div className="settings-layout">
        {settingsQuery.isError ? (
          <Card>
            <CardContent className="metric-card">
              <span className="metric-label text-red-600">Settings API Error</span>
              <strong className="metric-value">
                {settingsQuery.error instanceof Error
                  ? settingsQuery.error.message
                  : "/api/settings response could not be loaded."}
              </strong>
            </CardContent>
          </Card>
        ) : null}

        {saveError ? (
          <Card className="border-red-300">
            <CardContent className="settings-message error">{saveError}</CardContent>
          </Card>
        ) : null}
        {saveMessage ? (
          <Card className="border-emerald-300">
            <CardContent className="settings-message success">{saveMessage}</CardContent>
          </Card>
        ) : null}

        {!draft ? (
          <Card>
            <CardContent className="settings-loading">Loading settings...</CardContent>
          </Card>
        ) : (
          <>
            <section className="settings-tab-list" aria-label="settings tabs">
              {settingsTabs.map((tab) => (
                <Link
                  key={tab.id}
                  to="/setting/$section"
                  params={{ section: tab.path }}
                  className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
                >
                  {tab.label}
                </Link>
              ))}
            </section>

            {activeTab === "general" ? (
              <section className="settings-general-panel space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>General Settings</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="settings-field max-w-md">
                      <label
                        className="block text-sm font-medium mb-1"
                        htmlFor="application-timezone"
                      >
                        Application Timezone
                      </label>
                      <Select
                        id="application-timezone"
                        aria-label="Application Timezone"
                        value={getRawTimezoneSetting()}
                        onChange={(event) => {
                          const val = event.target.value;
                          setTimezoneSetting(val);
                          setSaveError(null);
                          setSaveMessage(
                            `Timezone updated to ${val === "system" ? `System Default (${Intl.DateTimeFormat().resolvedOptions().timeZone})` : val}.`,
                          );
                        }}
                      >
                        {timezoneOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </Select>
                      <p className="text-xs text-muted-foreground mt-2">
                        Configure the timezone used for displaying all timestamps across the
                        dashboard.
                      </p>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Distillation Target Priority Order</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Queue claim order. Top item is highest priority.
                    </p>
                    <div className="space-y-2">
                      {draft.general.distillationPriority.targetPriorityOrder.map((kind, index) => (
                        <div
                          key={kind}
                          className="flex items-center justify-between rounded-md border p-2"
                        >
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">#{index + 1}</Badge>
                            <span className="text-sm font-medium">{kind}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => movePriorityTargetKind(kind, -1)}
                              disabled={index === 0}
                            >
                              <ArrowUp size={14} />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => movePriorityTargetKind(kind, 1)}
                              disabled={
                                index ===
                                draft.general.distillationPriority.targetPriorityOrder.length - 1
                              }
                            >
                              <ArrowDown size={14} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Available kinds: {distillationPriorityTargetKinds.join(", ")}
                    </p>
                  </CardContent>
                </Card>
              </section>
            ) : null}

            {activeTab === "providers" ? renderProviderEndpointsPanel() : null}

            {activeTab === "taskRouting" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Task Routing</CardTitle>
                  <p className="settings-task-routing-intro">
                    Assign provider/model and task-specific runtime limits per pipeline step. Model
                    options follow the selected LLM Provider settings.
                  </p>
                </CardHeader>
                <CardContent className="settings-routes">
                  <section className="settings-route-matrix">
                    <div className="settings-route-matrix-header">
                      <div>
                        <h3>Route Matrix</h3>
                        <p>
                          Primary and fallback order for each task. Local LLM rows show the selected
                          local target from Provider Registry.
                        </p>
                      </div>
                    </div>
                    <RouteEditor
                      label="findCandidate"
                      description="Candidate extraction from source and vibe-memory targets."
                      settings={draft}
                      route={draft.taskRouting.findCandidate.source}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            findCandidate: {
                              ...current.taskRouting.findCandidate,
                              source: next,
                              vibe: next,
                            },
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="webSourceResearch"
                      description="URL fetch and web-source markdown generation."
                      settings={draft}
                      route={draft.taskRouting.webSourceResearch}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            webSourceResearch: next,
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="coverEvidence"
                      description="Shared route for source support, external evidence, and MCP evidence."
                      settings={draft}
                      route={draft.taskRouting.coverEvidence.externalEvidence}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            coverEvidence: {
                              sourceSupport: next,
                              externalEvidence: next,
                              mcpEvidence: next,
                            },
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="deadZoneMergeReview"
                      description="Queued DeadZone merge verification and cleanup."
                      settings={draft}
                      route={draft.taskRouting.deadZoneMergeReview}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            deadZoneMergeReview: next,
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="finalizeDistille"
                      description="Final candidate-to-knowledge generation."
                      settings={draft}
                      route={draft.taskRouting.finalizeDistille}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            finalizeDistille: next,
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="agenticCompile"
                      description="Compile helper route used by context compile and related runtime paths."
                      settings={draft}
                      providerOptions={agenticProviders}
                      route={{
                        provider: draft.taskRouting.agenticCompile.provider,
                        model: draft.taskRouting.agenticCompile.model,
                        localLlmModel: draft.taskRouting.agenticCompile.localLlmModel,
                        fallback: draft.taskRouting.agenticCompile.fallback,
                        azureDeploymentSlots: draft.taskRouting.agenticCompile.azureDeploymentSlots,
                      }}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            agenticCompile: {
                              ...current.taskRouting.agenticCompile,
                              provider: next.provider as RuntimeProviderName,
                              model:
                                next.model ??
                                resolveConfiguredRouteModel(current, next.provider) ??
                                current.taskRouting.agenticCompile.model,
                              localLlmModel: next.localLlmModel,
                              fallback: next.fallback,
                              azureDeploymentSlots: next.azureDeploymentSlots,
                            },
                          },
                        }))
                      }
                    />
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Find Candidate Runtime</h3>
                      <p>Candidate extraction timeouts, tool budget, and queue cadence.</p>
                    </div>
                    <div className="settings-route-row">
                      <div className="settings-route-header">
                        <div className="settings-route-label">findCandidate.runtime</div>
                        <p className="settings-route-description">
                          Limit the candidate extraction LLM call and source reader loop.
                        </p>
                      </div>
                      <div className="settings-route-fields">
                        {renderDistillationRuntimeNumberField({
                          label: "Find Candidate LLM Timeout (seconds)",
                          settingKey: "findCandidateTimeoutMs",
                          min: 1,
                          max: 3600,
                          unit: "secondsFromMilliseconds",
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Find Candidate Tool Calls",
                          settingKey: "findCandidateMaxToolCalls",
                          min: 1,
                          max: 64,
                        })}
                      </div>
                    </div>
                    <div className="settings-route-row">
                      <div className="settings-route-header">
                        <div className="settings-route-label">findCandidate.throttling</div>
                        <p className="settings-route-description">
                          Background interval and cooldown controls for findCandidate.
                        </p>
                      </div>
                      <div className="settings-route-fields">
                        <label className="settings-field">
                          <span>Finding Queue Task Interval (seconds)</span>
                          <Input
                            type="number"
                            min={0}
                            max={3600}
                            value={draft.advanced.findingQueueTaskIntervalSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                advanced: {
                                  ...current.advanced,
                                  findingQueueTaskIntervalSeconds: parseIntegerInput(
                                    event.target.value,
                                    current.advanced.findingQueueTaskIntervalSeconds,
                                  ),
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Enable Background Scheduler</span>
                          <Checkbox
                            checked={draft.taskRouting.findCandidate.throttling.backgroundEnabled}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      backgroundEnabled: event.target.checked,
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Interactive Window (sec)</span>
                          <Input
                            type="number"
                            min={30}
                            max={3600}
                            value={
                              draft.taskRouting.findCandidate.throttling.interactiveWindowSeconds
                            }
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      interactiveWindowSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .interactiveWindowSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Recent Interactive Block (sec)</span>
                          <Input
                            type="number"
                            min={0}
                            max={600}
                            value={draft.taskRouting.findCandidate.throttling.recentBlockSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      recentBlockSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .recentBlockSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Min Interval (sec)</span>
                          <Input
                            type="number"
                            min={1}
                            max={3600}
                            value={draft.taskRouting.findCandidate.throttling.minIntervalSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      minIntervalSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .minIntervalSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Medium Interval (sec)</span>
                          <Input
                            type="number"
                            min={1}
                            max={7200}
                            value={draft.taskRouting.findCandidate.throttling.mediumIntervalSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      mediumIntervalSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .mediumIntervalSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Busy Interval (sec)</span>
                          <Input
                            type="number"
                            min={1}
                            max={21600}
                            value={draft.taskRouting.findCandidate.throttling.busyIntervalSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      busyIntervalSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .busyIntervalSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Max Interval (sec)</span>
                          <Input
                            type="number"
                            min={1}
                            max={86400}
                            value={draft.taskRouting.findCandidate.throttling.maxIntervalSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      maxIntervalSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .maxIntervalSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Rate Limit Cooldown (sec)</span>
                          <Input
                            type="number"
                            min={30}
                            max={172800}
                            value={
                              draft.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds
                            }
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      rateLimitCooldownSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling
                                          .rateLimitCooldownSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Jitter (sec)</span>
                          <Input
                            type="number"
                            min={0}
                            max={600}
                            value={draft.taskRouting.findCandidate.throttling.jitterSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  findCandidate: {
                                    ...current.taskRouting.findCandidate,
                                    throttling: {
                                      ...current.taskRouting.findCandidate.throttling,
                                      jitterSeconds: parseIntegerInput(
                                        event.target.value,
                                        current.taskRouting.findCandidate.throttling.jitterSeconds,
                                      ),
                                    },
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Cover Evidence Runtime</h3>
                      <p>Covering Evidence queue cadence, LLM timeout, and tool-call limits.</p>
                    </div>
                    <div className="settings-route-row">
                      <div className="settings-route-header">
                        <div className="settings-route-label">coverEvidence.runtime</div>
                        <p className="settings-route-description">
                          Limit Cover Evidence LLM calls and external evidence tools.
                        </p>
                      </div>
                      <div className="settings-route-fields">
                        <label className="settings-field">
                          <span>Covering Queue Task Interval (seconds)</span>
                          <Input
                            type="number"
                            min={0}
                            max={3600}
                            value={draft.advanced.coveringQueueTaskIntervalSeconds}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                advanced: {
                                  ...current.advanced,
                                  coveringQueueTaskIntervalSeconds: parseIntegerInput(
                                    event.target.value,
                                    current.advanced.coveringQueueTaskIntervalSeconds,
                                  ),
                                },
                              }))
                            }
                          />
                        </label>
                        {renderDistillationRuntimeNumberField({
                          label: "Cover Evidence LLM Timeout (seconds)",
                          settingKey: "coverEvidenceTimeoutMs",
                          min: 1,
                          max: 3600,
                          unit: "secondsFromMilliseconds",
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Cover Evidence Search Calls",
                          settingKey: "coverEvidenceSearchMaxCalls",
                          min: 0,
                          max: 16,
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Cover Evidence Fetch Calls",
                          settingKey: "coverEvidenceFetchMaxCalls",
                          min: 0,
                          max: 16,
                        })}
                      </div>
                    </div>
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Shared Distillation Runtime</h3>
                      <p>
                        Cross-step defaults and fallback limits that are not owned by a single task.
                      </p>
                    </div>
                    <div className="settings-route-row">
                      <div className="settings-route-header">
                        <div className="settings-route-label">distillation.sharedRuntime</div>
                        <p className="settings-route-description">
                          These values still save to distillationRuntime, but live beside routing so
                          task behavior can be reviewed in one place.
                        </p>
                      </div>
                      <div className="settings-route-fields">
                        {renderDistillationRuntimeNumberField({
                          label: "Distillation Timeout (seconds)",
                          settingKey: "timeoutMs",
                          min: 1,
                          max: 3600,
                          unit: "secondsFromMilliseconds",
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Candidate Timeout (seconds)",
                          settingKey: "candidateTimeoutMs",
                          min: 1,
                          max: 3600,
                          unit: "secondsFromMilliseconds",
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Max Tool Rounds",
                          settingKey: "maxToolRounds",
                          min: 0,
                          max: 64,
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Tool Result Max Chars",
                          settingKey: "toolResultMaxChars",
                          min: 512,
                          max: 200_000,
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Failure Retry Delay (sec)",
                          settingKey: "failureRetryDelaySeconds",
                          min: 1,
                          max: 604_800,
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Reader Max Reads",
                          settingKey: "readerMaxReads",
                          min: 1,
                          max: 64,
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Reader Max Chars Per Read",
                          settingKey: "readerMaxCharsPerRead",
                          min: 128,
                          max: 200_000,
                        })}
                        {renderDistillationRuntimeNumberField({
                          label: "Low Importance Reject Threshold",
                          settingKey: "lowImportanceRejectThreshold",
                          min: 0,
                          max: 100,
                          step: 0.1,
                          parse: parseFloatInput,
                        })}
                      </div>
                    </div>
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Agentic Compile</h3>
                      <p>
                        Configure the compile helper route used by context compile and related
                        runtime paths.
                      </p>
                    </div>
                    <div className="settings-route-row">
                      <div className="settings-route-header">
                        <div className="settings-route-label">agenticCompile.runtime</div>
                        <p className="settings-route-description">
                          Orchestrates compile-time reasoning. Enable/disable and set timeout/token
                          limits here.
                        </p>
                      </div>
                      <div className="settings-route-fields settings-route-fields-agentic">
                        <label className="settings-check settings-check-inline">
                          <Checkbox
                            checked={draft.taskRouting.agenticCompile.enabled}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    enabled: event.target.checked,
                                  },
                                },
                              }))
                            }
                          />
                          enabled
                        </label>
                        <label className="settings-field">
                          <span>Timeout (seconds)</span>
                          <Input
                            type="number"
                            min={1}
                            value={millisecondsToSeconds(
                              draft.taskRouting.agenticCompile.timeoutMs,
                            )}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    timeoutMs: parseSecondsToMillisecondsInput(
                                      event.target.value,
                                      current.taskRouting.agenticCompile.timeoutMs,
                                    ),
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>Max Tokens</span>
                          <Input
                            type="number"
                            min={128}
                            value={draft.taskRouting.agenticCompile.maxTokens}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    maxTokens: parseIntegerInput(
                                      event.target.value,
                                      current.taskRouting.agenticCompile.maxTokens,
                                    ),
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  </section>
                </CardContent>
              </Card>
            ) : null}

            {activeTab === "search" ? (
              <section className="settings-search-grid">
                <Card>
                  <CardHeader>
                    <CardTitle>Search Routing</CardTitle>
                  </CardHeader>
                  <CardContent className="settings-card-grid">
                    <div className="settings-provider-order-list">
                      {draft.search.providerOrder.map((provider, index) => (
                        <div key={provider} className="settings-provider-order-item">
                          <div className="settings-provider-order-name">
                            <strong>{provider}</strong>
                            <span>
                              {provider === "brave" && draft.search.providers.brave.enabled
                                ? "enabled"
                                : provider === "exa" && draft.search.providers.exa.enabled
                                  ? "enabled"
                                  : provider === "duckduckgo" &&
                                      draft.search.providers.duckduckgo.enabled
                                    ? "enabled"
                                    : "disabled"}
                            </span>
                          </div>
                          <div className="settings-provider-order-actions">
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="outline"
                              onClick={() => moveSearchProvider(provider, -1)}
                              disabled={index === 0}
                            >
                              <ArrowUp size={14} />
                            </Button>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="outline"
                              onClick={() => moveSearchProvider(provider, 1)}
                              disabled={index === draft.search.providerOrder.length - 1}
                            >
                              <ArrowDown size={14} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.search.providers.brave.enabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              providers: {
                                ...current.search.providers,
                                brave: { enabled: event.target.checked },
                              },
                            },
                          }))
                        }
                      />
                      brave enabled
                    </label>
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.search.providers.exa.enabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              providers: {
                                ...current.search.providers,
                                exa: { enabled: event.target.checked },
                              },
                            },
                          }))
                        }
                      />
                      exa enabled
                    </label>
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.search.providers.duckduckgo.enabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              providers: {
                                ...current.search.providers,
                                duckduckgo: { enabled: event.target.checked },
                              },
                            },
                          }))
                        }
                      />
                      duckduckgo enabled
                    </label>
                    <label className="settings-field">
                      <span>Max Provider Attempts</span>
                      <Input
                        type="number"
                        min={1}
                        max={3}
                        value={draft.search.maxProviderAttempts}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              maxProviderAttempts: parseIntegerInput(
                                event.target.value,
                                current.search.maxProviderAttempts,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Result Count</span>
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={draft.search.resultCount}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              resultCount: parseIntegerInput(
                                event.target.value,
                                current.search.resultCount,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Timeout (seconds)</span>
                      <Input
                        type="number"
                        min={1}
                        max={120}
                        value={millisecondsToSeconds(draft.search.timeoutMs)}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              timeoutMs: parseSecondsToMillisecondsInput(
                                event.target.value,
                                current.search.timeoutMs,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Rate Limit Cooldown (sec)</span>
                      <Input
                        type="number"
                        min={30}
                        max={172800}
                        value={draft.search.rateLimitCooldownSeconds}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              rateLimitCooldownSeconds: parseIntegerInput(
                                event.target.value,
                                current.search.rateLimitCooldownSeconds,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Search Secrets</CardTitle>
                  </CardHeader>
                  <CardContent className="settings-card-grid">
                    {sourceView
                      ? renderSecretEditor(
                          "braveApiKey",
                          "Brave API Key",
                          sourceView.search.providers.brave.apiKeySecret,
                        )
                      : null}
                    {sourceView
                      ? renderSecretEditor(
                          "exaApiKey",
                          "Exa API Key",
                          sourceView.search.providers.exa.apiKeySecret,
                        )
                      : null}
                  </CardContent>
                </Card>
              </section>
            ) : null}

            {activeTab === "embedding" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Embedding / Local Runtime</CardTitle>
                </CardHeader>
                <CardContent className="settings-form-grid">
                  <label className="settings-field">
                    <span>Provider</span>
                    <Select
                      value={draft.embedding.provider}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          embedding: {
                            ...current.embedding,
                            provider: event.target
                              .value as RuntimeSettingsEditable["embedding"]["provider"],
                          },
                        }))
                      }
                    >
                      <option value="auto">auto</option>
                      <option value="daemon">daemon</option>
                      <option value="cli">cli</option>
                      <option value="openai">openai</option>
                      <option value="disabled">disabled</option>
                    </Select>
                  </label>
                  <label className="settings-field">
                    <span>Daemon URL</span>
                    <Input
                      value={draft.embedding.daemonUrl}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          embedding: {
                            ...current.embedding,
                            daemonUrl: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>OpenAI Model</span>
                    <Input
                      value={draft.embedding.openaiModel}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          embedding: {
                            ...current.embedding,
                            openaiModel: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Timeout (seconds)</span>
                    <Input
                      type="number"
                      min={1}
                      max={120}
                      value={millisecondsToSeconds(draft.embedding.timeoutMs)}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          embedding: {
                            ...current.embedding,
                            timeoutMs: parseSecondsToMillisecondsInput(
                              event.target.value,
                              current.embedding.timeoutMs,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                </CardContent>
              </Card>
            ) : null}

            {activeTab === "advanced" ? (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>Advanced Runtime Controls</CardTitle>
                  </CardHeader>
                  <CardContent className="settings-form-grid">
                    <label className="settings-field">
                      <span>Pipeline Lock Stale (sec)</span>
                      <Input
                        type="number"
                        min={30}
                        value={draft.advanced.pipelineLockStaleSeconds}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              pipelineLockStaleSeconds: parseIntegerInput(
                                event.target.value,
                                current.advanced.pipelineLockStaleSeconds,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Lock TTL (sec)</span>
                      <Input
                        type="number"
                        min={30}
                        value={draft.advanced.lockTtlSeconds}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              lockTtlSeconds: parseIntegerInput(
                                event.target.value,
                                current.advanced.lockTtlSeconds,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Pipeline Loop Claim Limit</span>
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        value={draft.advanced.pipelineClaimLimit}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              pipelineClaimLimit: parseIntegerInput(
                                event.target.value,
                                current.advanced.pipelineClaimLimit,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Continuous Idle Sleep (seconds)</span>
                      <Input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={millisecondsToSeconds(draft.advanced.continuousIdleSleepMs)}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              continuousIdleSleepMs: parseSecondsToMillisecondsInput(
                                event.target.value,
                                current.advanced.continuousIdleSleepMs,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Continuous Error Sleep (seconds)</span>
                      <Input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={millisecondsToSeconds(draft.advanced.continuousErrorSleepMs)}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              continuousErrorSleepMs: parseSecondsToMillisecondsInput(
                                event.target.value,
                                current.advanced.continuousErrorSleepMs,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Inventory Refresh Interval (seconds)</span>
                      <Input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={millisecondsToSeconds(draft.advanced.inventoryRefreshIntervalMs)}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              inventoryRefreshIntervalMs: parseSecondsToMillisecondsInput(
                                event.target.value,
                                current.advanced.inventoryRefreshIntervalMs,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Doctor Freshness Threshold (min)</span>
                      <Input
                        type="number"
                        min={1}
                        value={draft.advanced.doctorFreshnessThresholdMinutes}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              doctorFreshnessThresholdMinutes: parseIntegerInput(
                                event.target.value,
                                current.advanced.doctorFreshnessThresholdMinutes,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Doctor Degraded Rate Threshold</span>
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={draft.advanced.doctorDegradedRateThreshold}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              doctorDegradedRateThreshold: parseFloatInput(
                                event.target.value,
                                current.advanced.doctorDegradedRateThreshold,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Doctor Zero-use Warning Min Active Count</span>
                      <Input
                        type="number"
                        min={1}
                        value={draft.advanced.doctorKnowledgeZeroUseWarningMinActiveCount}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              doctorKnowledgeZeroUseWarningMinActiveCount: parseIntegerInput(
                                event.target.value,
                                current.advanced.doctorKnowledgeZeroUseWarningMinActiveCount,
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Agent Log Synchronization</CardTitle>
                  </CardHeader>
                  <CardContent className="settings-form-grid">
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.advanced.codexLogSyncEnabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              codexLogSyncEnabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      Enable Codex (Cursor) Log Sync
                    </label>
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.advanced.antigravityLogSyncEnabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              antigravityLogSyncEnabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      Enable Antigravity Log Sync
                    </label>
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.advanced.claudeLogSyncEnabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            advanced: {
                              ...current.advanced,
                              claudeLogSyncEnabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      Enable Claude Code Log Sync
                    </label>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
