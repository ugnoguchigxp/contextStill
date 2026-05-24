import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, RefreshCcw, RotateCcw, Save, Stethoscope, Trash2 } from "lucide-react";
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
  fetchRuntimeSettings,
  reloadRuntimeSettingsCache,
  testRuntimeProvider,
  updateRuntimeSettings,
} from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";

type SettingsTabId =
  | "providers"
  | "taskRouting"
  | "search"
  | "embedding"
  | "distillationRuntime"
  | "advanced";
type SettingsTabPath =
  | "llmprovider"
  | "taskrouting"
  | "search"
  | "embedding"
  | "distillation-runtime"
  | "advanced";

type SecretDraftState = Record<RuntimeSecretKey, { value: string; clear: boolean }>;

const settingsTabs: Array<{ id: SettingsTabId; label: string; path: SettingsTabPath }> = [
  { id: "providers", label: "LLM Providers", path: "llmprovider" },
  { id: "taskRouting", label: "Task Routing", path: "taskrouting" },
  { id: "search", label: "Search", path: "search" },
  { id: "embedding", label: "Embedding / Local Runtime", path: "embedding" },
  { id: "distillationRuntime", label: "Distillation Runtime", path: "distillation-runtime" },
  { id: "advanced", label: "Advanced", path: "advanced" },
];

const runtimeProviders: RuntimeProviderName[] = ["openai", "azure-openai", "bedrock", "local-llm"];
const runtimeProviderOptions: RuntimeProviderSetting[] = [...runtimeProviders, "auto"];
const runtimeSearchProviders: RuntimeSearchProvider[] = ["brave", "exa", "duckduckgo"];

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", { hour12: false });
}

function parseIntegerInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function getConfiguredModelByProvider(
  settings: RuntimeSettingsEditable,
): Record<RuntimeProviderName, string> {
  return {
    openai: settings.providers.openai.model.trim(),
    "azure-openai": settings.providers["azure-openai"].model.trim(),
    bedrock: settings.providers.bedrock.model.trim(),
    "local-llm": settings.providers["local-llm"].model.trim(),
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

function routeModelDisplayText(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderSetting,
): string {
  if (provider === "auto") {
    const labels = runtimeProviders
      .map((name) => {
        const model = resolveConfiguredRouteModel(settings, name);
        return model ? `${name}: ${model}` : null;
      })
      .filter((item): item is string => Boolean(item));
    if (labels.length === 0) return "auto (not configured)";
    return `auto (${labels.join(" / ")})`;
  }

  return resolveConfiguredRouteModel(settings, provider) ?? "not configured";
}

function providerOptionLabel(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderSetting,
): string {
  if (provider === "auto") return "auto";
  return `${provider} / ${routeModelDisplayText(settings, provider)}`;
}

function resolveActiveSettingsTab(pathname: string): SettingsTabId {
  const match = pathname.match(/^\/(?:setting|settings)\/([^/]+)\/?$/);
  if (!match) return "providers";
  const slug = match[1];
  const found = settingsTabs.find((tab) => tab.path === slug);
  return found?.id ?? "providers";
}

function createEmptySecretDraftState(): SecretDraftState {
  return {
    openaiApiKey: { value: "", clear: false },
    azureOpenAiApiKey: { value: "", clear: false },
    localLlmApiKey: { value: "", clear: false },
    braveApiKey: { value: "", clear: false },
    exaApiKey: { value: "", clear: false },
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
      },
    },
    taskRouting: {
      findCandidate: {
        source: {
          provider: view.taskRouting.findCandidate.source.provider,
          model: view.taskRouting.findCandidate.source.model,
          fallback: [...view.taskRouting.findCandidate.source.fallback],
        },
        vibe: {
          provider: view.taskRouting.findCandidate.vibe.provider,
          model: view.taskRouting.findCandidate.vibe.model,
          fallback: [...view.taskRouting.findCandidate.vibe.fallback],
        },
      },
      coverEvidence: {
        sourceSupport: {
          provider: view.taskRouting.coverEvidence.sourceSupport.provider,
          model: view.taskRouting.coverEvidence.sourceSupport.model,
          fallback: [...view.taskRouting.coverEvidence.sourceSupport.fallback],
        },
        externalEvidence: {
          provider: view.taskRouting.coverEvidence.externalEvidence.provider,
          model: view.taskRouting.coverEvidence.externalEvidence.model,
          fallback: [...view.taskRouting.coverEvidence.externalEvidence.fallback],
        },
        mcpEvidence: {
          provider: view.taskRouting.coverEvidence.mcpEvidence.provider,
          model: view.taskRouting.coverEvidence.mcpEvidence.model,
          fallback: [...view.taskRouting.coverEvidence.mcpEvidence.fallback],
        },
      },
      finalizeDistille: {
        provider: view.taskRouting.finalizeDistille.provider,
        model: view.taskRouting.finalizeDistille.model,
        fallback: [...view.taskRouting.finalizeDistille.fallback],
      },
      agenticCompile: {
        enabled: view.taskRouting.agenticCompile.enabled,
        provider: view.taskRouting.agenticCompile.provider,
        model: view.taskRouting.agenticCompile.model,
        fallback: [...view.taskRouting.agenticCompile.fallback],
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
                {providerOptionLabel(settings, provider)}
              </option>
            ))}
          </Select>
        </label>
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
                {providerOptionLabel(settings, provider)}
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
                {providerOptionLabel(settings, provider)}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </div>
  );
}

export function SettingsPage() {
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

  const settingsQuery = useQuery({
    queryKey: ["runtime-settings"],
    queryFn: () => fetchRuntimeSettings(),
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
  }, [snapshot?.revision, baseEditable]);

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

            {activeTab === "providers" ? (
              <section className="settings-provider-grid">
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
                    <CardTitle>Azure OpenAI</CardTitle>
                    <div className="settings-provider-actions">
                      <ProviderHealthBadge health={providerHealth["azure-openai"]} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => providerTestMutation.mutate("azure-openai")}
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
                    <label className="settings-field">
                      <span>API Base URL</span>
                      <Input
                        value={draft.providers["azure-openai"].apiBaseUrl}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "azure-openai": {
                                ...current.providers["azure-openai"],
                                apiBaseUrl: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>API Path</span>
                      <Input
                        value={draft.providers["azure-openai"].apiPath}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "azure-openai": {
                                ...current.providers["azure-openai"],
                                apiPath: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>API Version</span>
                      <Input
                        value={draft.providers["azure-openai"].apiVersion}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "azure-openai": {
                                ...current.providers["azure-openai"],
                                apiVersion: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>Model</span>
                      <Input
                        value={draft.providers["azure-openai"].model}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "azure-openai": {
                                ...current.providers["azure-openai"],
                                model: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
                    {sourceView
                      ? renderSecretEditor(
                          "azureOpenAiApiKey",
                          "API Key",
                          sourceView.providers["azure-openai"].apiKeySecret,
                        )
                      : null}
                  </CardContent>
                </Card>

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
                              "local-llm": {
                                ...current.providers["local-llm"],
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
                        value={draft.providers["local-llm"].model}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            providers: {
                              ...current.providers,
                              "local-llm": {
                                ...current.providers["local-llm"],
                                model: event.target.value,
                              },
                            },
                          }))
                        }
                      />
                    </label>
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
                    Assign provider/model per pipeline step. Model options follow the selected LLM
                    Provider settings.
                  </p>
                </CardHeader>
                <CardContent className="settings-routes">
                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Find Candidate</h3>
                      <p>
                        Pick models for extracting candidate knowledge from sources and vibe memory.
                      </p>
                    </div>
                    <RouteEditor
                      label="findCandidate.source"
                      description="Extract candidate items from source documents."
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
                            },
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="findCandidate.vibe"
                      description="Extract candidate items from vibe memory/session history."
                      settings={draft}
                      route={draft.taskRouting.findCandidate.vibe}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            findCandidate: {
                              ...current.taskRouting.findCandidate,
                              vibe: next,
                            },
                          },
                        }))
                      }
                    />
                  </section>

                  <section className="settings-route-section">
                    <div className="settings-route-section-header">
                      <h3>Cover Evidence</h3>
                      <p>
                        Choose how evidence quality checks run before final distillation output is
                        produced.
                      </p>
                    </div>
                    <RouteEditor
                      label="coverEvidence.sourceSupport"
                      description="Validate supporting evidence from source-level context."
                      settings={draft}
                      route={draft.taskRouting.coverEvidence.sourceSupport}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            coverEvidence: {
                              ...current.taskRouting.coverEvidence,
                              sourceSupport: next,
                            },
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="coverEvidence.externalEvidence"
                      description="Validate claims against external search/fetch results."
                      settings={draft}
                      route={draft.taskRouting.coverEvidence.externalEvidence}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            coverEvidence: {
                              ...current.taskRouting.coverEvidence,
                              externalEvidence: next,
                            },
                          },
                        }))
                      }
                    />
                    <RouteEditor
                      label="coverEvidence.mcpEvidence"
                      description="Validate evidence gathered from MCP tools."
                      settings={draft}
                      route={draft.taskRouting.coverEvidence.mcpEvidence}
                      onChange={(next) =>
                        patchDraft((current) => ({
                          ...current,
                          taskRouting: {
                            ...current.taskRouting,
                            coverEvidence: {
                              ...current.taskRouting.coverEvidence,
                              mcpEvidence: next,
                            },
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
                            {runtimeProviders.map((provider) => (
                              <option key={provider} value={provider}>
                                {providerOptionLabel(draft, provider)}
                              </option>
                            ))}
                          </Select>
                        </label>
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
                                {providerOptionLabel(draft, provider)}
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
                                {providerOptionLabel(draft, provider)}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="settings-field">
                          <span>Timeout (ms)</span>
                          <Input
                            type="number"
                            min={1000}
                            value={draft.taskRouting.agenticCompile.timeoutMs}
                            onChange={(event) =>
                              patchDraft((current) => ({
                                ...current,
                                taskRouting: {
                                  ...current.taskRouting,
                                  agenticCompile: {
                                    ...current.taskRouting.agenticCompile,
                                    timeoutMs: parseIntegerInput(
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
                      <span>Timeout (ms)</span>
                      <Input
                        type="number"
                        min={1000}
                        max={120000}
                        value={draft.search.timeoutMs}
                        onChange={(event) =>
                          patchDraft((current) => ({
                            ...current,
                            search: {
                              ...current.search,
                              timeoutMs: parseIntegerInput(
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
                    <span>Timeout (ms)</span>
                    <Input
                      type="number"
                      min={1000}
                      max={120000}
                      value={draft.embedding.timeoutMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          embedding: {
                            ...current.embedding,
                            timeoutMs: parseIntegerInput(
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

            {activeTab === "distillationRuntime" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Distillation Runtime</CardTitle>
                </CardHeader>
                <CardContent className="settings-form-grid">
                  <label className="settings-field">
                    <span>Timeout (ms)</span>
                    <Input
                      type="number"
                      min={1000}
                      value={draft.distillationRuntime.timeoutMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            timeoutMs: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.timeoutMs,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Candidate Timeout (ms)</span>
                    <Input
                      type="number"
                      min={1000}
                      value={draft.distillationRuntime.candidateTimeoutMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            candidateTimeoutMs: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.candidateTimeoutMs,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Max Tool Rounds</span>
                    <Input
                      type="number"
                      min={0}
                      value={draft.distillationRuntime.maxToolRounds}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            maxToolRounds: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.maxToolRounds,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Tool Timeout (ms)</span>
                    <Input
                      type="number"
                      min={1000}
                      value={draft.distillationRuntime.toolTimeoutMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            toolTimeoutMs: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.toolTimeoutMs,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Tool Result Max Chars</span>
                    <Input
                      type="number"
                      min={512}
                      value={draft.distillationRuntime.toolResultMaxChars}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            toolResultMaxChars: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.toolResultMaxChars,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Failure Retry Delay (sec)</span>
                    <Input
                      type="number"
                      min={1}
                      value={draft.distillationRuntime.failureRetryDelaySeconds}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            failureRetryDelaySeconds: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.failureRetryDelaySeconds,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Reader Max Reads</span>
                    <Input
                      type="number"
                      min={1}
                      value={draft.distillationRuntime.readerMaxReads}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            readerMaxReads: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.readerMaxReads,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Reader Max Chars Per Read</span>
                    <Input
                      type="number"
                      min={128}
                      value={draft.distillationRuntime.readerMaxCharsPerRead}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            readerMaxCharsPerRead: parseIntegerInput(
                              event.target.value,
                              current.distillationRuntime.readerMaxCharsPerRead,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Low Importance Reject Threshold</span>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={draft.distillationRuntime.lowImportanceRejectThreshold}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          distillationRuntime: {
                            ...current.distillationRuntime,
                            lowImportanceRejectThreshold: parseFloatInput(
                              event.target.value,
                              current.distillationRuntime.lowImportanceRejectThreshold,
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
                    <span>Continuous Idle Sleep (ms)</span>
                    <Input
                      type="number"
                      min={100}
                      value={draft.advanced.continuousIdleSleepMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          advanced: {
                            ...current.advanced,
                            continuousIdleSleepMs: parseIntegerInput(
                              event.target.value,
                              current.advanced.continuousIdleSleepMs,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Continuous Error Sleep (ms)</span>
                    <Input
                      type="number"
                      min={100}
                      value={draft.advanced.continuousErrorSleepMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          advanced: {
                            ...current.advanced,
                            continuousErrorSleepMs: parseIntegerInput(
                              event.target.value,
                              current.advanced.continuousErrorSleepMs,
                            ),
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Inventory Refresh Interval (ms)</span>
                    <Input
                      type="number"
                      min={100}
                      value={draft.advanced.inventoryRefreshIntervalMs}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          advanced: {
                            ...current.advanced,
                            inventoryRefreshIntervalMs: parseIntegerInput(
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

            <Card>
              <CardHeader>
                <CardTitle>Provider Health Snapshot</CardTitle>
              </CardHeader>
              <CardContent className="settings-health-grid">
                {runtimeProviders.map((provider) => (
                  <div key={provider} className="settings-health-item">
                    <div className="settings-health-head">
                      <strong>{providerTitle(provider)}</strong>
                      <ProviderHealthBadge health={providerHealth[provider]} />
                    </div>
                    <div className="settings-health-meta">
                      <span>provider {provider}</span>
                      <span>model {providerHealth[provider]?.model ?? "-"}</span>
                      <span>endpoint {providerHealth[provider]?.endpoint ?? "-"}</span>
                      <span>{providerHealth[provider]?.error ?? "no error"}</span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => providerTestMutation.mutate(provider)}
                      disabled={providerTestMutation.isPending}
                    >
                      <RefreshCcw size={14} />
                      Re-test
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
