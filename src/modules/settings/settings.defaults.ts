import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import { readProjectEnv } from "../../project-identity.js";
import type { SettingsRow } from "./settings.repository.js";
import {
  type DistillationPriorityTargetKind,
  type RuntimeProviderName,
  type RuntimeProviderSetting,
  type RuntimeSecretKey,
  type RuntimeSettingsEditable,
  type RuntimeSettingsRoute,
  type RuntimeSettingsSecrets,
  type RuntimeAgenticProviderName,
  distillationPriorityTargetKindValues,
  runtimeProviderNames,
  runtimeSettingsEditableSchema,
} from "./settings.types.js";

export const secretRowKeys: RuntimeSecretKey[] = [
  "openaiApiKey",
  "azureOpenAiApiKey",
  "azureOpenAiApiKey2",
  "azureOpenAiApiKey3",
  "localLlmApiKey",
  "braveApiKey",
  "exaApiKey",
];

type BootstrapConfig = {
  general: RuntimeSettingsEditable["general"];
  providers: RuntimeSettingsEditable["providers"];
  taskRouting: RuntimeSettingsEditable["taskRouting"];
  search: RuntimeSettingsEditable["search"];
  embedding: RuntimeSettingsEditable["embedding"];
  distillationRuntime: RuntimeSettingsEditable["distillationRuntime"];
  advanced: RuntimeSettingsEditable["advanced"];
  secrets: RuntimeSettingsSecrets;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeProviderName(value: unknown): RuntimeProviderName | undefined {
  if (typeof value !== "string") return undefined;
  return runtimeProviderNames.includes(value as RuntimeProviderName)
    ? (value as RuntimeProviderName)
    : undefined;
}

function normalizeProviderList(values: unknown[]): RuntimeProviderName[] {
  const deduped = new Set<RuntimeProviderName>();
  for (const value of values) {
    const normalized = normalizeProviderName(value);
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

const defaultDistillationTargetPriorityOrder: DistillationPriorityTargetKind[] = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
];
const localLlmAzureFallback: RuntimeProviderName[] = ["azure-openai"];

const distillationPriorityTargetKindSet = new Set<DistillationPriorityTargetKind>(
  distillationPriorityTargetKindValues,
);

const AZURE_OPENAI_MAX_DEPLOYMENTS = 3;

function normalizeAzureDeploymentSlots(values: unknown): number[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const deduped = new Set<number>();
  for (const value of values) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(numeric)) continue;
    if (numeric < 1 || numeric > AZURE_OPENAI_MAX_DEPLOYMENTS) continue;
    deduped.add(numeric);
  }
  const normalized = [...deduped];
  return normalized.length > 0 ? normalized : undefined;
}

function azureDeploymentName(index: number): string {
  return index === 0 ? "Primary" : `Deployment ${index + 1}`;
}

function normalizeAzureDeployment(
  value: Record<string, unknown>,
  index: number,
  fallback: RuntimeSettingsEditable["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"][number] {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const apiBaseUrl =
    typeof value.apiBaseUrl === "string"
      ? value.apiBaseUrl.trim().replace(/\/+$/, "")
      : index === 0
        ? fallback.apiBaseUrl
        : "";
  const apiPath =
    typeof value.apiPath === "string" && value.apiPath.trim()
      ? value.apiPath.trim()
      : fallback.apiPath;
  const apiVersion =
    typeof value.apiVersion === "string" && value.apiVersion.trim()
      ? value.apiVersion.trim()
      : fallback.apiVersion;
  const model =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : index === 0
        ? fallback.model
        : "";
  return {
    name: name || azureDeploymentName(index),
    apiBaseUrl,
    apiPath,
    apiVersion,
    model,
  };
}

function normalizeAzureDeployments(
  provider: RuntimeSettingsEditable["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"] {
  const rawDeployments = Array.isArray(provider.deployments) ? provider.deployments : [];
  const source =
    rawDeployments.length > 0
      ? rawDeployments
      : [
          {
            name: "Primary",
            apiBaseUrl: provider.apiBaseUrl,
            apiPath: provider.apiPath,
            apiVersion: provider.apiVersion,
            model: provider.model,
          },
        ];
  const deployments = source
    .slice(0, AZURE_OPENAI_MAX_DEPLOYMENTS)
    .map((value, index) => normalizeAzureDeployment(asRecord(value), index, provider));
  return deployments.length > 0
    ? deployments
    : [
        {
          name: "Primary",
          apiBaseUrl: provider.apiBaseUrl,
          apiPath: provider.apiPath,
          apiVersion: provider.apiVersion,
          model: provider.model,
        },
      ];
}

function syncAzureOpenAiProvider(
  provider: RuntimeSettingsEditable["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"] {
  const deployments = normalizeAzureDeployments(provider);
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

export function normalizeDistillationTargetPriorityOrder(
  values: unknown,
): DistillationPriorityTargetKind[] {
  const source = Array.isArray(values) ? values : [];
  const deduped: DistillationPriorityTargetKind[] = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    if (!distillationPriorityTargetKindSet.has(raw as DistillationPriorityTargetKind)) continue;
    const next = raw as DistillationPriorityTargetKind;
    if (!deduped.includes(next)) deduped.push(next);
  }
  for (const fallback of defaultDistillationTargetPriorityOrder) {
    if (!deduped.includes(fallback)) deduped.push(fallback);
  }
  return deduped;
}

export const bootstrap: BootstrapConfig = {
  general: {
    distillationPriority: {
      targetPriorityOrder: [...defaultDistillationTargetPriorityOrder],
    },
  },
  providers: {
    openai: {
      enabled: true,
      apiBaseUrl: groupedConfig.openAi.apiBaseUrl,
      model: groupedConfig.openAi.model,
    },
    "azure-openai": {
      enabled: Boolean(
        groupedConfig.azureOpenAi.apiBaseUrl.trim() &&
          groupedConfig.azureOpenAi.model.trim() &&
          groupedConfig.azureOpenAi.apiKey.trim(),
      ),
      apiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
      apiPath: groupedConfig.azureOpenAi.apiPath,
      apiVersion: groupedConfig.azureOpenAi.apiVersion,
      model: groupedConfig.azureOpenAi.model,
      deployments: [
        {
          name: "Primary",
          apiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
          apiPath: groupedConfig.azureOpenAi.apiPath,
          apiVersion: groupedConfig.azureOpenAi.apiVersion,
          model: groupedConfig.azureOpenAi.model,
        },
        ...[2, 3]
          .map((slot) => ({
            name: `Deployment ${slot}`,
            apiBaseUrl:
              readProjectEnv(`AZURE_OPENAI_${slot}_API_BASE_URL`)?.trim() ??
              process.env[`AZURE_OPENAI_${slot}_API_BASE_URL`]?.trim() ??
              "",
            apiPath:
              readProjectEnv(`AZURE_OPENAI_${slot}_API_PATH`)?.trim() || "/openai/deployments",
            apiVersion:
              readProjectEnv(`AZURE_OPENAI_${slot}_API_VERSION`)?.trim() ||
              groupedConfig.azureOpenAi.apiVersion,
            model:
              readProjectEnv(`AZURE_OPENAI_${slot}_MODEL`)?.trim() ??
              process.env[`AZURE_OPENAI_${slot}_MODEL`]?.trim() ??
              "",
          }))
          .filter((deployment) => deployment.apiBaseUrl || deployment.model),
      ].slice(0, AZURE_OPENAI_MAX_DEPLOYMENTS),
    },
    bedrock: {
      enabled: Boolean(groupedConfig.bedrock.region.trim() && groupedConfig.bedrock.model.trim()),
      region: groupedConfig.bedrock.region,
      profile: groupedConfig.bedrock.profile,
      model: groupedConfig.bedrock.model,
    },
    "local-llm": {
      enabled: Boolean(
        groupedConfig.localLlm.apiBaseUrl.trim() && groupedConfig.localLlm.model.trim(),
      ),
      apiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
      model: groupedConfig.localLlm.model,
    },
    codex: {
      enabled: false,
      model: "codex-sdk-agent",
    },
  },
  taskRouting: {
    findCandidate: {
      source: { provider: "openai", model: groupedConfig.openAi.model, fallback: [] },
      vibe: { provider: "openai", model: groupedConfig.openAi.model, fallback: [] },
      throttling: {
        backgroundEnabled: groupedConfig.distillation.findCandidateBackgroundEnabled,
        interactiveWindowSeconds: groupedConfig.distillation.findCandidateInteractiveWindowSeconds,
        recentBlockSeconds: groupedConfig.distillation.findCandidateRecentBlockSeconds,
        minIntervalSeconds: groupedConfig.distillation.findCandidateMinIntervalSeconds,
        mediumIntervalSeconds: groupedConfig.distillation.findCandidateMediumIntervalSeconds,
        busyIntervalSeconds: groupedConfig.distillation.findCandidateBusyIntervalSeconds,
        maxIntervalSeconds: groupedConfig.distillation.findCandidateMaxIntervalSeconds,
        rateLimitCooldownSeconds: groupedConfig.distillation.findCandidateRateLimitCooldownSeconds,
        jitterSeconds: groupedConfig.distillation.findCandidateJitterSeconds,
      },
    },
    webSourceResearch: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [...localLlmAzureFallback],
    },
    coverEvidence: {
      sourceSupport: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [...localLlmAzureFallback],
      },
      externalEvidence: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [...localLlmAzureFallback],
      },
      mcpEvidence: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [...localLlmAzureFallback],
      },
    },
    finalizeDistille: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [...localLlmAzureFallback],
    },
    agenticCompile: {
      enabled: groupedConfig.agenticCompile.enabled,
      provider: "openai",
      model: groupedConfig.openAi.model,
      fallback: ["local-llm"],
      timeoutMs: groupedConfig.agenticCompile.timeoutMs,
      maxTokens: groupedConfig.agenticCompile.maxTokens,
    },
  },
  search: {
    providerOrder: [...groupedConfig.distillationTools.searchProviders],
    maxProviderAttempts: groupedConfig.distillationTools.searchMaxProviderAttempts,
    resultCount: groupedConfig.distillationTools.searchResultCount,
    timeoutMs: groupedConfig.distillationTools.timeoutMs,
    rateLimitCooldownSeconds: groupedConfig.distillationTools.searchRateLimitCooldownSeconds,
    providers: {
      brave: { enabled: true },
      exa: { enabled: true },
      duckduckgo: { enabled: true },
    },
  },
  embedding: {
    provider: groupedConfig.embedding.provider,
    daemonUrl: groupedConfig.embedding.daemonUrl,
    openaiModel: groupedConfig.embedding.openaiModel,
    timeoutMs: groupedConfig.embedding.timeoutMs,
  },
  distillationRuntime: {
    timeoutMs: groupedConfig.distillation.timeoutMs,
    candidateTimeoutMs: groupedConfig.distillation.candidateTimeoutMs,
    maxToolRounds: groupedConfig.distillationTools.maxRounds,
    findCandidateTimeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
    findCandidateMaxToolCalls: groupedConfig.distillationTools.findCandidateMaxToolCalls,
    coverEvidenceTimeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
    coverEvidenceSearchMaxCalls: groupedConfig.distillationTools.coverEvidenceSearchMaxCalls,
    coverEvidenceFetchMaxCalls: groupedConfig.distillationTools.coverEvidenceFetchMaxCalls,
    toolTimeoutMs: groupedConfig.distillationTools.timeoutMs,
    toolResultMaxChars: groupedConfig.distillationTools.resultMaxChars,
    failureRetryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
    readerMaxReads: groupedConfig.distillationTools.readerMaxReads,
    readerMaxCharsPerRead: groupedConfig.distillationTools.readerMaxCharsPerRead,
    lowImportanceRejectThreshold: groupedConfig.distillation.lowImportanceRejectThreshold,
  },
  advanced: {
    pipelineLockStaleSeconds: groupedConfig.distillation.pipelineLockStaleSeconds,
    lockTtlSeconds: groupedConfig.distillation.lockTtlSeconds,
    pipelineClaimLimit: groupedConfig.distillation.pipelineClaimLimit,
    continuousIdleSleepMs: groupedConfig.distillation.continuousIdleSleepMs,
    continuousErrorSleepMs: groupedConfig.distillation.continuousErrorSleepMs,
    inventoryRefreshIntervalMs: groupedConfig.distillation.inventoryRefreshIntervalMs,
    doctorFreshnessThresholdMinutes: groupedConfig.doctor.freshnessThresholdMinutes,
    doctorDegradedRateThreshold: groupedConfig.doctor.degradedRateThreshold,
    doctorKnowledgeZeroUseWarningMinActiveCount:
      groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
    codexLogSyncEnabled: true,
    antigravityLogSyncEnabled: true,
    claudeLogSyncEnabled: true,
  },
  secrets: {
    openaiApiKey: groupedConfig.openAi.apiKey.trim() || undefined,
    azureOpenAiApiKey: groupedConfig.azureOpenAi.apiKey.trim() || undefined,
    azureOpenAiApiKey2:
      readProjectEnv("AZURE_OPENAI_2_API_KEY")?.trim() ||
      process.env.AZURE_OPENAI_2_API_KEY?.trim() ||
      undefined,
    azureOpenAiApiKey3:
      readProjectEnv("AZURE_OPENAI_3_API_KEY")?.trim() ||
      process.env.AZURE_OPENAI_3_API_KEY?.trim() ||
      undefined,
    localLlmApiKey: groupedConfig.localLlm.apiKey.trim() || undefined,
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    exaApiKey:
      readProjectEnv("EXA_API_KEY")?.trim() || process.env.EXA_API_KEY?.trim() || undefined,
  },
};

export function cloneDefaultSettings(): RuntimeSettingsEditable {
  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: [...bootstrap.general.distillationPriority.targetPriorityOrder],
      },
    },
    providers: {
      openai: { ...bootstrap.providers.openai },
      "azure-openai": {
        ...bootstrap.providers["azure-openai"],
        deployments: bootstrap.providers["azure-openai"].deployments.map((deployment) => ({
          ...deployment,
        })),
      },
      bedrock: { ...bootstrap.providers.bedrock },
      "local-llm": { ...bootstrap.providers["local-llm"] },
      codex: { ...bootstrap.providers.codex },
    },
    taskRouting: {
      findCandidate: {
        source: {
          ...bootstrap.taskRouting.findCandidate.source,
          fallback: [...bootstrap.taskRouting.findCandidate.source.fallback],
          azureDeploymentSlots: bootstrap.taskRouting.findCandidate.source.azureDeploymentSlots
            ? [...bootstrap.taskRouting.findCandidate.source.azureDeploymentSlots]
            : undefined,
        },
        vibe: {
          ...bootstrap.taskRouting.findCandidate.vibe,
          fallback: [...bootstrap.taskRouting.findCandidate.vibe.fallback],
          azureDeploymentSlots: bootstrap.taskRouting.findCandidate.vibe.azureDeploymentSlots
            ? [...bootstrap.taskRouting.findCandidate.vibe.azureDeploymentSlots]
            : undefined,
        },
        throttling: { ...bootstrap.taskRouting.findCandidate.throttling },
      },
      webSourceResearch: {
        ...bootstrap.taskRouting.webSourceResearch,
        fallback: [...bootstrap.taskRouting.webSourceResearch.fallback],
        azureDeploymentSlots: bootstrap.taskRouting.webSourceResearch.azureDeploymentSlots
          ? [...bootstrap.taskRouting.webSourceResearch.azureDeploymentSlots]
          : undefined,
      },
      coverEvidence: {
        sourceSupport: {
          ...bootstrap.taskRouting.coverEvidence.sourceSupport,
          fallback: [...bootstrap.taskRouting.coverEvidence.sourceSupport.fallback],
          azureDeploymentSlots: bootstrap.taskRouting.coverEvidence.sourceSupport
            .azureDeploymentSlots
            ? [...bootstrap.taskRouting.coverEvidence.sourceSupport.azureDeploymentSlots]
            : undefined,
        },
        externalEvidence: {
          ...bootstrap.taskRouting.coverEvidence.externalEvidence,
          fallback: [...bootstrap.taskRouting.coverEvidence.externalEvidence.fallback],
          azureDeploymentSlots: bootstrap.taskRouting.coverEvidence.externalEvidence
            .azureDeploymentSlots
            ? [...bootstrap.taskRouting.coverEvidence.externalEvidence.azureDeploymentSlots]
            : undefined,
        },
        mcpEvidence: {
          ...bootstrap.taskRouting.coverEvidence.mcpEvidence,
          fallback: [...bootstrap.taskRouting.coverEvidence.mcpEvidence.fallback],
          azureDeploymentSlots: bootstrap.taskRouting.coverEvidence.mcpEvidence.azureDeploymentSlots
            ? [...bootstrap.taskRouting.coverEvidence.mcpEvidence.azureDeploymentSlots]
            : undefined,
        },
      },
      finalizeDistille: {
        ...bootstrap.taskRouting.finalizeDistille,
        fallback: [...bootstrap.taskRouting.finalizeDistille.fallback],
        azureDeploymentSlots: bootstrap.taskRouting.finalizeDistille.azureDeploymentSlots
          ? [...bootstrap.taskRouting.finalizeDistille.azureDeploymentSlots]
          : undefined,
      },
      agenticCompile: {
        ...bootstrap.taskRouting.agenticCompile,
        fallback: [...bootstrap.taskRouting.agenticCompile.fallback],
        azureDeploymentSlots: bootstrap.taskRouting.agenticCompile.azureDeploymentSlots
          ? [...bootstrap.taskRouting.agenticCompile.azureDeploymentSlots]
          : undefined,
      },
    },
    search: {
      ...bootstrap.search,
      providerOrder: [...bootstrap.search.providerOrder],
      providers: {
        brave: { ...bootstrap.search.providers.brave },
        exa: { ...bootstrap.search.providers.exa },
        duckduckgo: { ...bootstrap.search.providers.duckduckgo },
      },
    },
    embedding: { ...bootstrap.embedding },
    distillationRuntime: { ...bootstrap.distillationRuntime },
    advanced: { ...bootstrap.advanced },
  };
}

function resolveConfiguredRouteModel(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderSetting | RuntimeAgenticProviderName,
): string | undefined {
  if (provider === "auto") return undefined;
  switch (provider) {
    case "openai":
      return settings.providers.openai.model.trim() || undefined;
    case "azure-openai":
      return (
        settings.providers["azure-openai"].deployments
          .find((deployment) => deployment.model.trim())
          ?.model.trim() ||
        settings.providers["azure-openai"].model.trim() ||
        undefined
      );
    case "bedrock":
      return settings.providers.bedrock.model.trim() || undefined;
    case "local-llm":
      return settings.providers["local-llm"].model.trim() || undefined;
    case "codex":
      return settings.providers.codex.model.trim() || undefined;
  }
}

function sanitizeRoute(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeSettingsRoute {
  return {
    provider: route.provider,
    model: resolveConfiguredRouteModel(settings, route.provider),
    fallback: normalizeProviderList(route.fallback),
    azureDeploymentSlots: normalizeAzureDeploymentSlots(route.azureDeploymentSlots),
  };
}

function ensureLocalLlmAzureFallback(route: RuntimeSettingsRoute): RuntimeSettingsRoute {
  if (route.provider !== "local-llm" || route.fallback.includes("azure-openai")) {
    return route;
  }
  return {
    ...route,
    fallback: [...route.fallback, "azure-openai"],
  };
}

function mergeRuntimeSettings(
  defaults: RuntimeSettingsEditable,
  input: Record<string, unknown>,
): RuntimeSettingsEditable {
  const merged: RuntimeSettingsEditable = {
    ...defaults,
    general: {
      ...defaults.general,
      ...asRecord(input.general),
      distillationPriority: {
        ...defaults.general.distillationPriority,
        ...asRecord(asRecord(input.general).distillationPriority),
      },
    },
    providers: {
      ...defaults.providers,
      ...asRecord(input.providers),
      openai: {
        ...defaults.providers.openai,
        ...asRecord(asRecord(input.providers).openai),
      },
      "azure-openai": {
        ...defaults.providers["azure-openai"],
        ...asRecord(asRecord(input.providers)["azure-openai"]),
      },
      bedrock: {
        ...defaults.providers.bedrock,
        ...asRecord(asRecord(input.providers).bedrock),
      },
      "local-llm": {
        ...defaults.providers["local-llm"],
        ...asRecord(asRecord(input.providers)["local-llm"]),
      },
      codex: {
        ...defaults.providers.codex,
        ...asRecord(asRecord(input.providers).codex),
      },
    },
    taskRouting: {
      ...defaults.taskRouting,
      ...asRecord(input.taskRouting),
      findCandidate: {
        ...defaults.taskRouting.findCandidate,
        ...asRecord(asRecord(input.taskRouting).findCandidate),
        source: {
          ...defaults.taskRouting.findCandidate.source,
          ...asRecord(asRecord(asRecord(input.taskRouting).findCandidate).source),
        },
        vibe: {
          ...defaults.taskRouting.findCandidate.vibe,
          ...asRecord(asRecord(asRecord(input.taskRouting).findCandidate).vibe),
        },
        throttling: {
          ...defaults.taskRouting.findCandidate.throttling,
          ...asRecord(asRecord(asRecord(input.taskRouting).findCandidate).throttling),
        },
      },
      webSourceResearch: {
        ...defaults.taskRouting.webSourceResearch,
        ...asRecord(asRecord(input.taskRouting).webSourceResearch),
      },
      coverEvidence: {
        ...defaults.taskRouting.coverEvidence,
        ...asRecord(asRecord(input.taskRouting).coverEvidence),
        sourceSupport: {
          ...defaults.taskRouting.coverEvidence.sourceSupport,
          ...asRecord(asRecord(asRecord(input.taskRouting).coverEvidence).sourceSupport),
        },
        externalEvidence: {
          ...defaults.taskRouting.coverEvidence.externalEvidence,
          ...asRecord(asRecord(asRecord(input.taskRouting).coverEvidence).externalEvidence),
        },
        mcpEvidence: {
          ...defaults.taskRouting.coverEvidence.mcpEvidence,
          ...asRecord(asRecord(asRecord(input.taskRouting).coverEvidence).mcpEvidence),
        },
      },
      finalizeDistille: {
        ...defaults.taskRouting.finalizeDistille,
        ...asRecord(asRecord(input.taskRouting).finalizeDistille),
      },
      agenticCompile: {
        ...defaults.taskRouting.agenticCompile,
        ...asRecord(asRecord(input.taskRouting).agenticCompile),
      },
    },
    search: {
      ...defaults.search,
      ...asRecord(input.search),
      providers: {
        ...defaults.search.providers,
        ...asRecord(asRecord(input.search).providers),
        brave: {
          ...defaults.search.providers.brave,
          ...asRecord(asRecord(asRecord(input.search).providers).brave),
        },
        exa: {
          ...defaults.search.providers.exa,
          ...asRecord(asRecord(asRecord(input.search).providers).exa),
        },
        duckduckgo: {
          ...defaults.search.providers.duckduckgo,
          ...asRecord(asRecord(asRecord(input.search).providers).duckduckgo),
        },
      },
    },
    embedding: {
      ...defaults.embedding,
      ...asRecord(input.embedding),
    },
    distillationRuntime: {
      ...defaults.distillationRuntime,
      ...asRecord(input.distillationRuntime),
    },
    advanced: {
      ...defaults.advanced,
      ...asRecord(input.advanced),
    },
  };

  merged.providers["azure-openai"] = syncAzureOpenAiProvider(merged.providers["azure-openai"]);

  merged.taskRouting.findCandidate.source = sanitizeRoute(
    merged,
    merged.taskRouting.findCandidate.source,
  );
  merged.taskRouting.findCandidate.vibe = sanitizeRoute(
    merged,
    merged.taskRouting.findCandidate.vibe,
  );
  merged.taskRouting.webSourceResearch = sanitizeRoute(
    merged,
    merged.taskRouting.webSourceResearch,
  );
  merged.taskRouting.webSourceResearch = ensureLocalLlmAzureFallback(
    merged.taskRouting.webSourceResearch,
  );
  merged.taskRouting.coverEvidence.sourceSupport = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.sourceSupport,
  );
  merged.taskRouting.coverEvidence.sourceSupport = ensureLocalLlmAzureFallback(
    merged.taskRouting.coverEvidence.sourceSupport,
  );
  merged.taskRouting.coverEvidence.externalEvidence = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.externalEvidence,
  );
  merged.taskRouting.coverEvidence.externalEvidence = ensureLocalLlmAzureFallback(
    merged.taskRouting.coverEvidence.externalEvidence,
  );
  merged.taskRouting.coverEvidence.mcpEvidence = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.mcpEvidence,
  );
  merged.taskRouting.coverEvidence.mcpEvidence = ensureLocalLlmAzureFallback(
    merged.taskRouting.coverEvidence.mcpEvidence,
  );
  merged.taskRouting.finalizeDistille = sanitizeRoute(merged, merged.taskRouting.finalizeDistille);
  merged.taskRouting.finalizeDistille = ensureLocalLlmAzureFallback(
    merged.taskRouting.finalizeDistille,
  );
  merged.taskRouting.agenticCompile.fallback = normalizeProviderList(
    merged.taskRouting.agenticCompile.fallback,
  );
  merged.taskRouting.agenticCompile.azureDeploymentSlots = normalizeAzureDeploymentSlots(
    merged.taskRouting.agenticCompile.azureDeploymentSlots,
  );
  merged.general.distillationPriority.targetPriorityOrder =
    normalizeDistillationTargetPriorityOrder(
      merged.general.distillationPriority.targetPriorityOrder,
    );
  merged.search.providerOrder = [...new Set(merged.search.providerOrder)];
  groupedConfig.distillationTools.searchProviders = merged.search
    .providerOrder as DistillationSearchProvider[];
  return merged;
}

export function parseDocumentValue(row: SettingsRow | null): RuntimeSettingsEditable {
  const defaults = cloneDefaultSettings();
  if (!row) return defaults;
  const root = asRecord(row.value);
  const raw = asRecord(root.settings ?? root);
  const merged = mergeRuntimeSettings(defaults, raw);
  const parsed = runtimeSettingsEditableSchema.safeParse(merged);
  if (!parsed.success) return defaults;
  return parsed.data;
}
