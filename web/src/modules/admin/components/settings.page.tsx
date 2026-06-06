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
  type CodexAuthTokenInfo,
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

type SecretDraftState = Record<RuntimeSecretKey, { value: string; clear: boolean }>;

const azureOpenAiSecretKeys: RuntimeSecretKey[] = [
  "azureOpenAiApiKey",
  "azureOpenAiApiKey2",
  "azureOpenAiApiKey3",
];

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

const azureDeploymentSlotOptions = [1, 2, 3] as const;
const localLlmMaxModels = 10;

function normalizeAzureDeploymentSlots(values: number[] | undefined): number[] {
  if (!values || values.length === 0) return [];
  const deduped = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > 3) continue;
    deduped.add(value);
  }
  return [...deduped];
}

function patchAzureDeploymentSlot(
  values: number[] | undefined,
  slot: number,
  enabled: boolean,
): number[] | undefined {
  const current = new Set(normalizeAzureDeploymentSlots(values));
  if (enabled) {
    current.add(slot);
  } else {
    current.delete(slot);
  }
  const next = [...current].sort((left, right) => left - right);
  return next.length > 0 ? next : undefined;
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

function localLlmRouteModelOptions(settings: RuntimeSettingsEditable): string[] {
  return [
    ...new Set(
      settings.providers["local-llm"].models
        .map((item) => item.model.trim())
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}

function providerNameOptionLabel(provider: RuntimeProviderSetting): string {
  return provider;
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
  return [0, 1, 2].map((index) => {
    const deployment = deployments[index];
    return {
      name: deployment?.name || (index === 0 ? "Primary" : `Deployment ${index + 1}`),
      apiBaseUrl: deployment?.apiBaseUrl ?? (index === 0 ? provider.apiBaseUrl : ""),
      apiPath: deployment?.apiPath || provider.apiPath || "/openai/deployments",
      apiVersion: deployment?.apiVersion || provider.apiVersion || "2025-04-01-preview",
      model: deployment?.model ?? (index === 0 ? provider.model : ""),
    };
  });
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
          model: provider.model,
        },
      ];
  return models.slice(0, localLlmMaxModels).map((model, index) => ({
    name: model.name || (index === 0 ? "Primary" : `Local LLM ${index + 1}`),
    apiBaseUrl: model.apiBaseUrl ?? (index === 0 ? provider.apiBaseUrl : ""),
    model: model.model ?? (index === 0 ? provider.model : ""),
  }));
}

function syncLocalLlmProviderForDraft(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
  models: RuntimeSettingsEditable["providers"]["local-llm"]["models"],
): RuntimeSettingsEditable["providers"]["local-llm"] {
  const nextModels = models.slice(0, localLlmMaxModels);
  const primary = nextModels[0];
  return {
    ...provider,
    apiBaseUrl: primary?.apiBaseUrl ?? provider.apiBaseUrl,
    model: primary?.model ?? provider.model,
    models: nextModels,
  };
}

function buildSecretPayload(
  secretDrafts: SecretDraftState,
): Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>> | undefined {
  const result: Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>> = {};
  for (const key of Object.keys(secretDrafts) as RuntimeSecretKey[]) {
    const item = secretDrafts[key];
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
          fallback: [...view.taskRouting.findCandidate.source.fallback],
          azureDeploymentSlots: view.taskRouting.findCandidate.source.azureDeploymentSlots
            ? [...view.taskRouting.findCandidate.source.azureDeploymentSlots]
            : undefined,
        },
        vibe: {
          provider: view.taskRouting.findCandidate.vibe.provider,
          model: view.taskRouting.findCandidate.vibe.model,
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
        fallback: [...view.taskRouting.webSourceResearch.fallback],
        azureDeploymentSlots: view.taskRouting.webSourceResearch.azureDeploymentSlots
          ? [...view.taskRouting.webSourceResearch.azureDeploymentSlots]
          : undefined,
      },
      coverEvidence: {
        sourceSupport: {
          provider: view.taskRouting.coverEvidence.sourceSupport.provider,
          model: view.taskRouting.coverEvidence.sourceSupport.model,
          fallback: [...view.taskRouting.coverEvidence.sourceSupport.fallback],
          azureDeploymentSlots: view.taskRouting.coverEvidence.sourceSupport.azureDeploymentSlots
            ? [...view.taskRouting.coverEvidence.sourceSupport.azureDeploymentSlots]
            : undefined,
        },
        externalEvidence: {
          provider: view.taskRouting.coverEvidence.externalEvidence.provider,
          model: view.taskRouting.coverEvidence.externalEvidence.model,
          fallback: [...view.taskRouting.coverEvidence.externalEvidence.fallback],
          azureDeploymentSlots: view.taskRouting.coverEvidence.externalEvidence.azureDeploymentSlots
            ? [...view.taskRouting.coverEvidence.externalEvidence.azureDeploymentSlots]
            : undefined,
        },
        mcpEvidence: {
          provider: view.taskRouting.coverEvidence.mcpEvidence.provider,
          model: view.taskRouting.coverEvidence.mcpEvidence.model,
          fallback: [...view.taskRouting.coverEvidence.mcpEvidence.fallback],
          azureDeploymentSlots: view.taskRouting.coverEvidence.mcpEvidence.azureDeploymentSlots
            ? [...view.taskRouting.coverEvidence.mcpEvidence.azureDeploymentSlots]
            : undefined,
        },
      },
      finalizeDistille: {
        provider: view.taskRouting.finalizeDistille.provider,
        model: view.taskRouting.finalizeDistille.model,
        fallback: [...view.taskRouting.finalizeDistille.fallback],
        azureDeploymentSlots: view.taskRouting.finalizeDistille.azureDeploymentSlots
          ? [...view.taskRouting.finalizeDistille.azureDeploymentSlots]
          : undefined,
      },
      deadZoneMergeReview: {
        provider: view.taskRouting.deadZoneMergeReview.provider,
        model: view.taskRouting.deadZoneMergeReview.model,
        fallback: [...view.taskRouting.deadZoneMergeReview.fallback],
        azureDeploymentSlots: view.taskRouting.deadZoneMergeReview.azureDeploymentSlots
          ? [...view.taskRouting.deadZoneMergeReview.azureDeploymentSlots]
          : undefined,
      },
      agenticCompile: {
        enabled: view.taskRouting.agenticCompile.enabled,
        provider: view.taskRouting.agenticCompile.provider,
        model: view.taskRouting.agenticCompile.model,
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
}: {
  label: string;
  description: string;
  settings: RuntimeSettingsEditable;
  route: RuntimeSettingsRoute;
  onChange: (next: RuntimeSettingsRoute) => void;
}) {
  const fallbackSlots = toFallbackSlots(route.fallback);
  const azureSlots = normalizeAzureDeploymentSlots(route.azureDeploymentSlots);
  const localModelOptions = localLlmRouteModelOptions(settings);

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
              onChange({
                ...route,
                provider,
                model: resolveConfiguredRouteModel(settings, provider),
              });
            }}
          >
            {runtimeProviderOptions.map((provider) => (
              <option key={provider} value={provider}>
                {providerNameOptionLabel(provider)}
              </option>
            ))}
          </Select>
        </label>
        {route.provider === "local-llm" ? (
          <label className="settings-field">
            <span>Model</span>
            <Select
              value={route.model ?? ""}
              onChange={(event) =>
                onChange({
                  ...route,
                  model:
                    event.target.value || resolveConfiguredRouteModel(settings, route.provider),
                })
              }
            >
              {localModelOptions.length === 0 ? (
                <option value="">not configured</option>
              ) : (
                localModelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))
              )}
            </Select>
          </label>
        ) : null}
        <label className="settings-field">
          <span>Fallback 1</span>
          <Select
            value={fallbackSlots[0]}
            onChange={(event) =>
              onChange({
                ...route,
                fallback: patchFallbackSlot(
                  route.fallback,
                  0,
                  event.target.value as FallbackSelectValue,
                ),
              })
            }
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
            onChange={(event) =>
              onChange({
                ...route,
                fallback: patchFallbackSlot(
                  route.fallback,
                  1,
                  event.target.value as FallbackSelectValue,
                ),
              })
            }
          >
            <option value="">none</option>
            {runtimeProviders.map((provider) => (
              <option key={provider} value={provider}>
                {providerNameOptionLabel(provider)}
              </option>
            ))}
          </Select>
        </label>
        <div className="settings-field">
          <span>Azure Slots</span>
          <div className="flex flex-wrap items-center gap-3 py-2">
            {azureDeploymentSlotOptions.map((slot) => (
              <label key={slot} className="settings-check">
                <Checkbox
                  checked={azureSlots.includes(slot)}
                  onChange={(event) =>
                    onChange({
                      ...route,
                      azureDeploymentSlots: patchAzureDeploymentSlot(
                        route.azureDeploymentSlots,
                        slot,
                        event.target.checked,
                      ),
                    })
                  }
                />
                #{slot}
              </label>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">empty = all configured deployments</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Codex Auth sub-components
// ---------------------------------------------------------------------------

function CodexTokenInfoPanel({ tokenInfo }: { tokenInfo: CodexAuthTokenInfo }) {
  const expiresDate = tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt) : null;
  const formattedExpiry = expiresDate
    ? expiresDate.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        tokenInfo.isExpired
          ? "border-destructive/50 bg-destructive/5"
          : "border-success/40 bg-success/5"
      }`}
    >
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <span>{tokenInfo.isExpired ? "⚠️" : "✅"}</span>
        <span>
          {tokenInfo.isExpired
            ? "Token Expired — Re-login Required"
            : "Authenticated via ChatGPT OAuth"}
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        {tokenInfo.email && (
          <div className="flex gap-2">
            <span className="w-24 shrink-0">Account</span>
            <span className="font-medium text-foreground">{tokenInfo.email}</span>
          </div>
        )}
        <div className="flex gap-2">
          <span className="w-24 shrink-0">Auth Mode</span>
          <span className="font-mono">{tokenInfo.authMode}</span>
        </div>
        {formattedExpiry && (
          <div className="flex gap-2">
            <span className="w-24 shrink-0">Token Expiry</span>
            <span className={tokenInfo.isExpired ? "text-destructive font-medium" : ""}>
              {formattedExpiry}
              {tokenInfo.isExpired ? " (expired)" : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

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
        return item.clear || item.value.trim().length > 0;
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
        settings: draft,
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
      [key]: { ...current[key], clear: false },
    }));
  };

  const renderSecretEditor = (
    key: RuntimeSecretKey,
    label: string,
    status: RuntimeSecretStatus,
  ) => (
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
          value={secretDrafts[key].value}
          placeholder="new value"
          onChange={(event) => setSecretValue(key, event.target.value)}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => markSecretReplace(key)}>
          <Save size={14} />
          Replace
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={() => markSecretClear(key)}>
          <Trash2 size={14} />
          Clear
        </Button>
        {secretDrafts[key].clear ? <Badge variant="destructive">pending clear</Badge> : null}
        {secretDrafts[key].value.trim() ? <Badge variant="warning">pending replace</Badge> : null}
      </div>
    </div>
  );

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

  const providerTitle = (provider: RuntimeProviderName): string => {
    switch (provider) {
      case "openai":
        return "OpenAI";
      case "azure-openai":
        return "Azure OpenAI";
      case "bedrock":
        return "AWS Bedrock";
      case "local-llm":
        return "Local LLM";
      case "codex":
        return "Codex Auth";
    }
  };

  const settingsStatus: "ok" | "failed" = settingsQuery.isError || saveError ? "failed" : "ok";

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

            {activeTab === "providers" ? (
              <section className="settings-provider-grid">
                {/* === Azure OpenAI (left) | OpenAI + Codex (right) === */}
                <div className="settings-openai-group">
                  {/* Left: Azure OpenAI */}
                  <Card className="settings-openai-group__azure">
                    <CardHeader className="settings-provider-header">
                      <CardTitle>Azure OpenAI</CardTitle>
                    </CardHeader>
                    <CardContent className="settings-card-grid">
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
                        enabled
                      </label>
                      {draft.providers["azure-openai"].deployments.map((deployment, index) => {
                        const secretKey = azureOpenAiSecretKeys[index] ?? "azureOpenAiApiKey";
                        const secretStatus =
                          sourceView?.providers["azure-openai"].apiKeySecrets[index] ??
                          (sourceView ? emptyRuntimeSecretStatus() : null);
                        return (
                          <div key={secretKey} className="settings-provider-deployment">
                            <div className="settings-deployment-header">
                              <div className="settings-secret-meta">
                                <strong>Deployment {index + 1}</strong>
                              </div>
                            </div>
                            <label className="settings-field">
                              <span>Deployment {index + 1} Name</span>
                              <Input
                                value={deployment.name}
                                onChange={(event) =>
                                  patchDraft((current) => {
                                    const deployments = current.providers[
                                      "azure-openai"
                                    ].deployments.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, name: event.target.value }
                                        : item,
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
                                  })
                                }
                              />
                            </label>
                            <label className="settings-field">
                              <span>Deployment {index + 1} Endpoint</span>
                              <Input
                                value={deployment.apiBaseUrl}
                                onChange={(event) =>
                                  patchDraft((current) => {
                                    const deployments = current.providers[
                                      "azure-openai"
                                    ].deployments.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, apiBaseUrl: event.target.value }
                                        : item,
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
                                  })
                                }
                              />
                            </label>
                            <label className="settings-field">
                              <span>Deployment {index + 1} API Path</span>
                              <Input
                                value={deployment.apiPath}
                                onChange={(event) =>
                                  patchDraft((current) => {
                                    const deployments = current.providers[
                                      "azure-openai"
                                    ].deployments.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, apiPath: event.target.value }
                                        : item,
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
                                  })
                                }
                              />
                            </label>
                            <label className="settings-field">
                              <span>Deployment {index + 1} API Version</span>
                              <Input
                                value={deployment.apiVersion}
                                onChange={(event) =>
                                  patchDraft((current) => {
                                    const deployments = current.providers[
                                      "azure-openai"
                                    ].deployments.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, apiVersion: event.target.value }
                                        : item,
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
                                  })
                                }
                              />
                            </label>
                            <label className="settings-field">
                              <span>Deployment {index + 1} Model</span>
                              <Input
                                value={deployment.model}
                                onChange={(event) =>
                                  patchDraft((current) => {
                                    const deployments = current.providers[
                                      "azure-openai"
                                    ].deployments.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, model: event.target.value }
                                        : item,
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
                                  })
                                }
                              />
                            </label>
                            {secretStatus
                              ? renderSecretEditor(secretKey, `API Key ${index + 1}`, secretStatus)
                              : null}
                            <div className="settings-deployment-health">
                              <ProviderHealthBadge health={azureDeploymentHealth[index]} />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => azureDeploymentTestMutation.mutate(index)}
                                disabled={azureDeploymentTestMutation.isPending}
                              >
                                <Stethoscope size={14} />
                                Test {index + 1}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>

                  {/* Right: OpenAI (top) + Codex (bottom) */}
                  <div className="settings-openai-group__stack">
                    <Card>
                      <CardHeader className="settings-provider-header">
                        <CardTitle>OpenAI</CardTitle>
                        <div className="settings-provider-actions">
                          <ProviderHealthBadge health={providerHealth.openai} />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => providerTestMutation.mutate("openai")}
                            disabled={providerTestMutation.isPending}
                          >
                            <Stethoscope size={14} />
                            Test
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="settings-card-grid">
                        <label className="settings-check">
                          <Checkbox
                            checked={draft.providers.openai.enabled}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                providers: {
                                  ...current.providers,
                                  openai: {
                                    ...current.providers.openai,
                                    enabled: event.target.checked,
                                  },
                                },
                              }))
                            }
                          />
                          enabled
                        </label>
                        <label className="settings-field">
                          <span>API Base URL</span>
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
                          <span>Model</span>
                          <Input
                            value={draft.providers.openai.model}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                providers: {
                                  ...current.providers,
                                  openai: {
                                    ...current.providers.openai,
                                    model: event.target.value,
                                  },
                                },
                              }))
                            }
                          />
                        </label>
                        {sourceView
                          ? renderSecretEditor(
                              "openaiApiKey",
                              "API Key",
                              sourceView.providers.openai.apiKeySecret,
                            )
                          : null}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="settings-provider-header">
                        <CardTitle>Codex</CardTitle>
                        <div className="settings-provider-actions">
                          {codexAuthQuery.isLoading ? (
                            <Badge variant="outline">Checking...</Badge>
                          ) : codexAuthQuery.data ? (
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
                                ? "✓ Logged in"
                                : codexAuthQuery.data.tokenInfo?.isExpired
                                  ? "Token Expired"
                                  : "Login Required"}
                            </Badge>
                          ) : null}
                        </div>
                      </CardHeader>
                      <CardContent className="settings-card-grid">
                        <label className="settings-check">
                          <Checkbox
                            checked={draft.providers.codex?.enabled ?? false}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                providers: {
                                  ...current.providers,
                                  codex: {
                                    ...current.providers.codex,
                                    enabled: event.target.checked,
                                  },
                                },
                              }))
                            }
                          />
                          enabled
                        </label>
                        <label className="settings-field">
                          <span>Model</span>
                          <Select
                            value={draft.providers.codex?.model ?? "codex-sdk-agent"}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                providers: {
                                  ...current.providers,
                                  codex: {
                                    ...current.providers.codex,
                                    model: event.target.value,
                                  },
                                },
                              }))
                            }
                          >
                            <option value="codex-sdk-agent">codex-sdk-agent (Default Agent)</option>
                            <option value="gpt-5.5">gpt-5.5 (Next-Gen Reasoner)</option>
                            <option value="gpt-5.4-mini">gpt-5.4-mini (Efficient Assistant)</option>
                            <option value="gpt-5.2-codex">gpt-5.2-codex (Specialized Codex)</option>
                          </Select>
                        </label>
                        {codexAuthQuery.data && (
                          <div className="settings-codex-status-details space-y-2 text-sm text-foreground">
                            {codexAuthQuery.data.tokenInfo && (
                              <CodexTokenInfoPanel tokenInfo={codexAuthQuery.data.tokenInfo} />
                            )}
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer select-none py-1 font-medium">
                                System Details
                              </summary>
                              <div className="mt-2 space-y-1">
                                <div className="flex justify-between border-b pb-1">
                                  <span>Codex Home</span>
                                  <span className="font-mono">{codexAuthQuery.data.codexHome}</span>
                                </div>
                                <div className="flex justify-between border-b pb-1">
                                  <span>CLI (codex) Available</span>
                                  <span>
                                    {codexAuthQuery.data.cliAvailable ? "✅ Yes" : "❌ No"}
                                  </span>
                                </div>
                                <div className="flex justify-between border-b pb-1">
                                  <span>~/.codex/auth.json</span>
                                  <span>
                                    {codexAuthQuery.data.authJsonExists
                                      ? "✅ Exists"
                                      : "❌ Not found"}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span>CODEX_ACCESS_TOKEN env</span>
                                  <span>
                                    {codexAuthQuery.data.accessTokenConfigured
                                      ? "✅ Set"
                                      : "— Not set"}
                                  </span>
                                </div>
                              </div>
                            </details>
                            <CodexActionGuide
                              recommendedAction={codexAuthQuery.data.recommendedAction}
                              isExpired={codexAuthQuery.data.tokenInfo?.isExpired ?? false}
                              loginCommand={loginCommand}
                              onGetCommand={() => getLoginCommandMutation.mutate()}
                              isPending={getLoginCommandMutation.isPending}
                              onRefresh={() => void codexAuthQuery.refetch()}
                            />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </div>

                <Card>
                  <CardHeader className="settings-provider-header">
                    <CardTitle>AWS Bedrock</CardTitle>
                    <div className="settings-provider-actions">
                      <ProviderHealthBadge health={providerHealth.bedrock} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => providerTestMutation.mutate("bedrock")}
                        disabled={providerTestMutation.isPending}
                      >
                        <Stethoscope size={14} />
                        Test
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="settings-card-grid">
                    <label className="settings-check">
                      <Checkbox
                        checked={draft.providers.bedrock.enabled}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              bedrock: {
                                ...current.providers.bedrock,
                                enabled: event.target.checked,
                              },
                            },
                          }))
                        }
                      />
                      enabled
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
                              bedrock: {
                                ...current.providers.bedrock,
                                region: event.target.value,
                              },
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
                              bedrock: {
                                ...current.providers.bedrock,
                                profile: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Model</span>
                      <Input
                        value={draft.providers.bedrock.model}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              bedrock: {
                                ...current.providers.bedrock,
                                model: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    {sourceView ? (
                      <div className="settings-secret-row">
                        <div className="settings-secret-meta">
                          <strong>Credential Status</strong>
                          <div className="settings-secret-status">
                            <SecretStatusBadge
                              status={sourceView.providers.bedrock.credentialSecret}
                            />
                            <span>
                              {sourceView.providers.bedrock.credentialSecret.maskedValue ?? "unset"}
                            </span>
                            <span>
                              updated{" "}
                              {formatDateTime(
                                sourceView.providers.bedrock.credentialSecret.updatedAt,
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="settings-provider-header">
                    <CardTitle>Local LLM</CardTitle>
                    <div className="settings-provider-actions">
                      <ProviderHealthBadge health={providerHealth["local-llm"]} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => providerTestMutation.mutate("local-llm")}
                        disabled={providerTestMutation.isPending}
                      >
                        <Stethoscope size={14} />
                        Test
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="settings-card-grid">
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
                      enabled
                    </label>
                    <label className="settings-field">
                      <span>API Base URL</span>
                      <Input
                        value={draft.providers["local-llm"].apiBaseUrl}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "local-llm": syncLocalLlmProviderForDraft(
                                current.providers["local-llm"],
                                current.providers["local-llm"].models.map((item, index) =>
                                  index === 0 ? { ...item, apiBaseUrl: event.target.value } : item,
                                ),
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Model</span>
                      <Input
                        value={draft.providers["local-llm"].model}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "local-llm": syncLocalLlmProviderForDraft(
                                current.providers["local-llm"],
                                current.providers["local-llm"].models.map((item, index) =>
                                  index === 0 ? { ...item, model: event.target.value } : item,
                                ),
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    {draft.providers["local-llm"].models.slice(1).map((model, modelIndex) => {
                      const index = modelIndex + 1;
                      return (
                        <div key={index} className="settings-local-llm-model">
                          <div className="settings-local-llm-model-header">
                            <strong>{model.name || `Local LLM ${index + 1}`}</strong>
                            <div className="settings-provider-actions">
                              <ProviderHealthBadge health={localLlmModelHealth[model.model]} />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => localLlmModelTestMutation.mutate(model.model)}
                                disabled={
                                  !model.model.trim() || localLlmModelTestMutation.isPending
                                }
                              >
                                <Stethoscope size={14} />
                                Test
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  patchDraft((current) => ({
                                    ...current,
                                    providers: {
                                      ...current.providers,
                                      "local-llm": syncLocalLlmProviderForDraft(
                                        current.providers["local-llm"],
                                        current.providers["local-llm"].models.filter(
                                          (_item, itemIndex) => itemIndex !== index,
                                        ),
                                      ),
                                    },
                                  }))
                                }
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          </div>
                          <label className="settings-field">
                            <span>Name</span>
                            <Input
                              value={model.name}
                              onChange={(event) =>
                                patchDraft((current) => ({
                                  ...current,
                                  providers: {
                                    ...current.providers,
                                    "local-llm": syncLocalLlmProviderForDraft(
                                      current.providers["local-llm"],
                                      current.providers["local-llm"].models.map(
                                        (item, itemIndex) =>
                                          itemIndex === index
                                            ? { ...item, name: event.target.value }
                                            : item,
                                      ),
                                    ),
                                  },
                                }))
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>API Base URL</span>
                            <Input
                              value={model.apiBaseUrl}
                              onChange={(event) =>
                                patchDraft((current) => ({
                                  ...current,
                                  providers: {
                                    ...current.providers,
                                    "local-llm": syncLocalLlmProviderForDraft(
                                      current.providers["local-llm"],
                                      current.providers["local-llm"].models.map(
                                        (item, itemIndex) =>
                                          itemIndex === index
                                            ? { ...item, apiBaseUrl: event.target.value }
                                            : item,
                                      ),
                                    ),
                                  },
                                }))
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>Model</span>
                            <Input
                              value={model.model}
                              onChange={(event) =>
                                patchDraft((current) => ({
                                  ...current,
                                  providers: {
                                    ...current.providers,
                                    "local-llm": syncLocalLlmProviderForDraft(
                                      current.providers["local-llm"],
                                      current.providers["local-llm"].models.map(
                                        (item, itemIndex) =>
                                          itemIndex === index
                                            ? { ...item, model: event.target.value }
                                            : item,
                                      ),
                                    ),
                                  },
                                }))
                              }
                            />
                          </label>
                        </div>
                      );
                    })}
                    <div className="settings-local-llm-add">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          patchDraft((current) => {
                            const models = current.providers["local-llm"].models;
                            if (models.length >= localLlmMaxModels) return current;
                            const nextIndex = models.length;
                            return {
                              ...current,
                              providers: {
                                ...current.providers,
                                "local-llm": syncLocalLlmProviderForDraft(
                                  current.providers["local-llm"],
                                  [
                                    ...models,
                                    {
                                      name: `Local LLM ${nextIndex + 1}`,
                                      apiBaseUrl: "",
                                      model: "",
                                    },
                                  ],
                                ),
                              },
                            };
                          })
                        }
                        disabled={draft.providers["local-llm"].models.length >= localLlmMaxModels}
                      >
                        <Plus size={14} />
                        Add Local LLM
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {draft.providers["local-llm"].models.length}/{localLlmMaxModels}
                      </span>
                    </div>
                    {sourceView
                      ? renderSecretEditor(
                          "localLlmApiKey",
                          "API Key",
                          sourceView.providers["local-llm"].apiKeySecret,
                        )
                      : null}
                  </CardContent>
                </Card>
              </section>
            ) : null}

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
                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Find Candidate</h3>
                      <p>
                        Pick the single route used to extract candidate knowledge from sources and
                        vibe memory.
                      </p>
                    </div>
                    <RouteEditor
                      label="findCandidate"
                      description="Process candidate extraction with one provider/model route."
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
                      <h3>Web Source Research</h3>
                      <p>URL ingest 時に fetch して調査 Markdown を作るルート設定です。</p>
                    </div>
                    <RouteEditor
                      label="webSourceResearch"
                      description="Fetch URL content and generate websource markdown."
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
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Cover Evidence</h3>
                      <p>
                        Choose the single route used by source checks, external evidence, and
                        optional MCP evidence while processing the Covering Evidence queue.
                      </p>
                    </div>
                    <RouteEditor
                      label="coverEvidence"
                      description="Process the Covering Evidence queue with one provider/model route."
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
                      <h3>DeadZone Merge Review</h3>
                      <p>Set model routing for queued DeadZone merge verification and cleanup.</p>
                    </div>
                    <RouteEditor
                      label="deadZoneMergeReview"
                      description="Review and rewrite canonical knowledge before applying DeadZone merges."
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
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Finalize Distille</h3>
                      <p>Set model routing for generating final candidate-to-knowledge output.</p>
                    </div>
                    <RouteEditor
                      label="finalizeDistille"
                      description="Produce the final distillation payload from reviewed candidates."
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
                        <div className="settings-route-label">agenticCompile</div>
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
                          <span>Provider</span>
                          <Select
                            value={draft.taskRouting.agenticCompile.provider}
                            onChange={(event) => {
                              const provider = event.target.value as RuntimeProviderName;
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    provider,
                                    model:
                                      resolveConfiguredRouteModel(current, provider) ??
                                      current.taskRouting.agenticCompile.model,
                                  },
                                },
                              }));
                            }}
                          >
                            {agenticProviders.map((provider) => (
                              <option key={provider} value={provider}>
                                {providerNameOptionLabel(provider)}
                              </option>
                            ))}
                          </Select>
                        </label>
                        {draft.taskRouting.agenticCompile.provider === "local-llm" ? (
                          <label className="settings-field">
                            <span>Model</span>
                            <Select
                              value={draft.taskRouting.agenticCompile.model}
                              onChange={(event) =>
                                patchDraft((current) => ({
                                  ...current,
                                  taskRouting: {
                                    ...current.taskRouting,
                                    agenticCompile: {
                                      ...current.taskRouting.agenticCompile,
                                      model:
                                        event.target.value ||
                                        resolveConfiguredRouteModel(current, "local-llm") ||
                                        current.taskRouting.agenticCompile.model,
                                    },
                                  },
                                }))
                              }
                            >
                              {localLlmRouteModelOptions(draft).length === 0 ? (
                                <option value="">not configured</option>
                              ) : (
                                localLlmRouteModelOptions(draft).map((model) => (
                                  <option key={model} value={model}>
                                    {model}
                                  </option>
                                ))
                              )}
                            </Select>
                          </label>
                        ) : null}
                        <label className="settings-field">
                          <span>Fallback 1</span>
                          <Select
                            value={toFallbackSlots(draft.taskRouting.agenticCompile.fallback)[0]}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    fallback: patchFallbackSlot(
                                      current.taskRouting.agenticCompile.fallback,
                                      0,
                                      event.target.value as FallbackSelectValue,
                                    ),
                                  },
                                },
                              }))
                            }
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
                            value={toFallbackSlots(draft.taskRouting.agenticCompile.fallback)[1]}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    fallback: patchFallbackSlot(
                                      current.taskRouting.agenticCompile.fallback,
                                      1,
                                      event.target.value as FallbackSelectValue,
                                    ),
                                  },
                                },
                              }))
                            }
                          >
                            <option value="">none</option>
                            {runtimeProviders.map((provider) => (
                              <option key={provider} value={provider}>
                                {providerNameOptionLabel(provider)}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <div className="settings-field">
                          <span>Azure Slots</span>
                          <div className="flex flex-wrap items-center gap-3 py-2">
                            {azureDeploymentSlotOptions.map((slot) => (
                              <label key={slot} className="settings-check">
                                <Checkbox
                                  checked={normalizeAzureDeploymentSlots(
                                    draft.taskRouting.agenticCompile.azureDeploymentSlots,
                                  ).includes(slot)}
                                  onChange={(event) =>
                                    patchDraft((current) => ({
                                      ...current,
                                      taskRouting: {
                                        ...current.taskRouting,
                                        agenticCompile: {
                                          ...current.taskRouting.agenticCompile,
                                          azureDeploymentSlots: patchAzureDeploymentSlot(
                                            current.taskRouting.agenticCompile.azureDeploymentSlots,
                                            slot,
                                            event.target.checked,
                                          ),
                                        },
                                      },
                                    }))
                                  }
                                />
                                #{slot}
                              </label>
                            ))}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            empty = all configured deployments
                          </span>
                        </div>
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
