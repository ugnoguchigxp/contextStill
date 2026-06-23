import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import { projectEnvKey } from "../../project-identity.js";
import { bootstrap, cloneDefaultSettings, secretRowKeys } from "./settings.defaults.js";
import type { SettingsRow } from "./settings.repository.js";
import type {
  RuntimeSecretKey,
  RuntimeSecretSource,
  RuntimeSecretStatus,
  RuntimeSettingsEditable,
  RuntimeSettingsView,
} from "./settings.types.js";

export type SecretValueEntry = {
  value: string;
  source: RuntimeSecretSource;
  updatedAt: string | null;
};

export type RuntimeSettingsCache = {
  loadedAt: Date | null;
  revision: number;
  settings: RuntimeSettingsEditable;
  view: RuntimeSettingsView;
  sources: Record<string, string>;
};

export function maskSecret(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.max(4, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

function emptyRuntimeSecretStatus(): RuntimeSecretStatus {
  return { configured: false, source: "none", maskedValue: null, updatedAt: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getSecretStringFromRow(row: SettingsRow | undefined): string | undefined {
  if (!row) return undefined;
  const record = asRecord(row.value);
  const direct = asString(record.value);
  return direct?.trim() ? direct.trim() : undefined;
}

function azureOpenAiSecretKey(index: number): RuntimeSecretKey {
  if (index === 1) return "azureOpenAiApiKey2";
  if (index === 2) return "azureOpenAiApiKey3";
  if (index > 2) return `azureOpenAiApiKey${index + 1}`;
  return "azureOpenAiApiKey";
}

function localLlmSecretKey(index: number): RuntimeSecretKey {
  if (index === 0) return "localLlmApiKey";
  return `localLlmApiKey${index + 1}`;
}

export function buildSecretMap(
  rows: SettingsRow[],
): Partial<Record<RuntimeSecretKey, SettingsRow | undefined>> {
  const result = Object.create(null) as Partial<Record<RuntimeSecretKey, SettingsRow | undefined>>;
  for (const key of secretRowKeys) {
    result[key] = rows.find((row) => row.key === key);
  }
  for (const row of rows) {
    if (/^azureOpenAiApiKey[1-9]\d*$/.test(row.key)) {
      result[row.key as RuntimeSecretKey] = row;
    }
    if (/^localLlmApiKey[1-9]\d*$/.test(row.key)) {
      result[row.key as RuntimeSecretKey] = row;
    }
  }
  return result;
}

export function resolveSecretValue(
  key: RuntimeSecretKey,
  secretRow: SettingsRow | undefined,
): SecretValueEntry | null {
  const dbValue = getSecretStringFromRow(secretRow);
  if (dbValue) {
    return {
      value: dbValue,
      source: "db",
      updatedAt: secretRow?.updatedAt.toISOString() ?? null,
    };
  }
  const envValue = bootstrap.secrets[key];
  if (envValue?.trim()) {
    return {
      value: envValue.trim(),
      source: "env",
      updatedAt: null,
    };
  }
  return null;
}

export function resolveBedrockCredentialStatus(
  settings: RuntimeSettingsEditable,
): RuntimeSecretStatus {
  const configured =
    Boolean(settings.providers.bedrock.profile.trim()) ||
    Boolean(process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim());
  return {
    configured,
    source: configured ? "env-or-profile" : "none",
    maskedValue: configured ? "***" : null,
    updatedAt: null,
  };
}

export function applyRuntimeSettingsToProcess(
  settings: RuntimeSettingsEditable,
  secrets: Partial<Record<RuntimeSecretKey, SecretValueEntry | null>>,
): void {
  const openAiEnabled = settings.providers.openai.enabled;
  const azureOpenAiEnabled = settings.providers["azure-openai"].enabled;
  const bedrockEnabled = settings.providers.bedrock.enabled;
  const localLlmEnabled = settings.providers["local-llm"].enabled;

  const azureDeployments = azureOpenAiEnabled
    ? settings.providers["azure-openai"].deployments.map((deployment, index) => ({
        apiKey: secrets[azureOpenAiSecretKey(index)]?.value ?? "",
        apiBaseUrl: deployment.apiBaseUrl.replace(/\/+$/, ""),
        apiPath: deployment.apiPath,
        apiVersion: deployment.apiVersion,
        model: deployment.model,
      }))
    : [];
  const configuredAzureDeployments = azureDeployments.filter(
    (deployment) =>
      deployment.apiKey.trim() && deployment.apiBaseUrl.trim() && deployment.model.trim(),
  );
  const primaryAzure = configuredAzureDeployments[0] ?? {
    apiKey: azureOpenAiEnabled ? (secrets.azureOpenAiApiKey?.value ?? "") : "",
    apiBaseUrl: settings.providers["azure-openai"].apiBaseUrl.replace(/\/+$/, ""),
    apiPath: settings.providers["azure-openai"].apiPath,
    apiVersion: settings.providers["azure-openai"].apiVersion,
    model: settings.providers["azure-openai"].model,
  };

  groupedConfig.openAi.apiBaseUrl = settings.providers.openai.apiBaseUrl.replace(/\/+$/, "");
  groupedConfig.openAi.model = settings.providers.openai.model;
  groupedConfig.openAi.apiKey = openAiEnabled ? (secrets.openaiApiKey?.value ?? "") : "";
  groupedConfig.azureOpenAi.apiBaseUrl = primaryAzure.apiBaseUrl;
  groupedConfig.azureOpenAi.apiPath = primaryAzure.apiPath;
  groupedConfig.azureOpenAi.apiVersion = primaryAzure.apiVersion;
  groupedConfig.azureOpenAi.model = primaryAzure.model;
  groupedConfig.azureOpenAi.apiKey = primaryAzure.apiKey;
  groupedConfig.azureOpenAi.deployments = azureDeployments;
  groupedConfig.bedrock.region = settings.providers.bedrock.region;
  groupedConfig.bedrock.profile = settings.providers.bedrock.profile;
  groupedConfig.bedrock.model = bedrockEnabled ? settings.providers.bedrock.model : "";
  const localLlmModels = localLlmEnabled
    ? settings.providers["local-llm"].models
        .map((model, index) => ({
          name: model.name,
          apiBaseUrl: model.apiBaseUrl.replace(/\/+$/, ""),
          apiPath: model.apiPath.trim() || "/v1/chat/completions",
          apiKey: secrets[localLlmSecretKey(index)]?.value ?? "",
          model: model.model,
        }))
        .filter((model) => model.apiBaseUrl.trim() && model.model.trim())
    : [];
  const primaryLocalLlm = localLlmModels[0] ?? {
    apiBaseUrl: settings.providers["local-llm"].apiBaseUrl.replace(/\/+$/, ""),
    apiPath: settings.providers["local-llm"].apiPath.trim() || "/v1/chat/completions",
    model: localLlmEnabled ? settings.providers["local-llm"].model : "",
    apiKey: localLlmEnabled ? (secrets.localLlmApiKey?.value ?? "") : "",
  };
  groupedConfig.localLlm.apiBaseUrl = primaryLocalLlm.apiBaseUrl;
  groupedConfig.localLlm.apiPath = primaryLocalLlm.apiPath;
  groupedConfig.localLlm.model = primaryLocalLlm.model;
  groupedConfig.localLlm.models = localLlmModels;
  groupedConfig.localLlm.apiKey = primaryLocalLlm.apiKey;
  groupedConfig.embedding.provider = settings.embedding.provider;
  groupedConfig.embedding.daemonUrl = settings.embedding.daemonUrl.replace(/\/+$/, "");
  groupedConfig.embedding.openaiModel = settings.embedding.openaiModel;
  groupedConfig.embedding.timeoutMs = settings.embedding.timeoutMs;
  groupedConfig.agenticCompile.enabled = settings.taskRouting.agenticCompile.enabled;
  groupedConfig.agenticCompile.provider = settings.taskRouting.agenticCompile.provider;
  groupedConfig.agenticCompile.timeoutMs = settings.taskRouting.agenticCompile.timeoutMs;
  groupedConfig.agenticCompile.maxTokens = settings.taskRouting.agenticCompile.maxTokens;
  groupedConfig.distillation.provider = settings.taskRouting.finalizeDistille.provider;
  groupedConfig.distillation.findCandidateProvider =
    settings.taskRouting.findCandidate.source.provider;
  groupedConfig.distillation.findCandidateBackgroundEnabled =
    settings.taskRouting.findCandidate.throttling.backgroundEnabled;
  groupedConfig.distillation.findCandidateInteractiveWindowSeconds =
    settings.taskRouting.findCandidate.throttling.interactiveWindowSeconds;
  groupedConfig.distillation.findCandidateRecentBlockSeconds =
    settings.taskRouting.findCandidate.throttling.recentBlockSeconds;
  groupedConfig.distillation.findCandidateMinIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.minIntervalSeconds;
  groupedConfig.distillation.findCandidateMediumIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.mediumIntervalSeconds;
  groupedConfig.distillation.findCandidateBusyIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.busyIntervalSeconds;
  groupedConfig.distillation.findCandidateMaxIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.maxIntervalSeconds;
  groupedConfig.distillation.findCandidateRateLimitCooldownSeconds =
    settings.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds;
  groupedConfig.distillation.findCandidateJitterSeconds =
    settings.taskRouting.findCandidate.throttling.jitterSeconds;
  groupedConfig.distillation.timeoutMs = settings.distillationRuntime.timeoutMs;
  groupedConfig.distillation.findCandidateTimeoutMs =
    settings.distillationRuntime.findCandidateTimeoutMs;
  groupedConfig.distillation.coverEvidenceTimeoutMs =
    settings.distillationRuntime.coverEvidenceTimeoutMs;
  groupedConfig.distillation.candidateTimeoutMs = settings.distillationRuntime.candidateTimeoutMs;
  groupedConfig.distillation.lowImportanceRejectThreshold =
    settings.distillationRuntime.lowImportanceRejectThreshold;
  groupedConfig.distillation.lockTtlSeconds = settings.advanced.lockTtlSeconds;
  groupedConfig.distillation.pipelineLockStaleSeconds = settings.advanced.pipelineLockStaleSeconds;
  groupedConfig.distillation.pipelineClaimLimit = settings.advanced.pipelineClaimLimit;
  groupedConfig.distillation.findingQueueTaskIntervalSeconds =
    settings.advanced.findingQueueTaskIntervalSeconds;
  groupedConfig.distillation.coveringQueueTaskIntervalSeconds =
    settings.advanced.coveringQueueTaskIntervalSeconds;
  groupedConfig.distillation.continuousIdleSleepMs = settings.advanced.continuousIdleSleepMs;
  groupedConfig.distillation.continuousErrorSleepMs = settings.advanced.continuousErrorSleepMs;
  groupedConfig.distillation.inventoryRefreshIntervalMs =
    settings.advanced.inventoryRefreshIntervalMs;

  const providerOrder = settings.search.providerOrder.filter((provider) => {
    if (provider === "brave") return settings.search.providers.brave.enabled;
    if (provider === "exa") return settings.search.providers.exa.enabled;
    return settings.search.providers.duckduckgo.enabled;
  });
  groupedConfig.distillationTools.searchProviders =
    providerOrder.length > 0 ? providerOrder : (["duckduckgo"] as DistillationSearchProvider[]);
  groupedConfig.distillationTools.searchMaxProviderAttempts = settings.search.maxProviderAttempts;
  groupedConfig.distillationTools.searchResultCount = settings.search.resultCount;
  groupedConfig.distillationTools.timeoutMs = settings.search.timeoutMs;
  groupedConfig.distillationTools.searchRateLimitCooldownSeconds =
    settings.search.rateLimitCooldownSeconds;
  groupedConfig.distillationTools.maxRounds = settings.distillationRuntime.maxToolRounds;
  groupedConfig.distillationTools.findCandidateMaxToolCalls =
    settings.distillationRuntime.findCandidateMaxToolCalls;
  groupedConfig.distillationTools.coverEvidenceSearchMaxCalls =
    settings.distillationRuntime.coverEvidenceSearchMaxCalls;
  groupedConfig.distillationTools.coverEvidenceFetchMaxCalls =
    settings.distillationRuntime.coverEvidenceFetchMaxCalls;
  groupedConfig.distillationTools.coverEvidenceFetchMaxTokensPerSite =
    settings.distillationRuntime.coverEvidenceFetchMaxTokensPerSite;
  groupedConfig.distillationTools.resultMaxChars = settings.distillationRuntime.toolResultMaxChars;
  groupedConfig.distillationTools.failureRetryDelaySeconds =
    settings.distillationRuntime.failureRetryDelaySeconds;
  groupedConfig.distillationTools.readerMaxReads = settings.distillationRuntime.readerMaxReads;
  groupedConfig.distillationTools.readerMaxCharsPerRead =
    settings.distillationRuntime.readerMaxCharsPerRead;

  groupedConfig.doctor.freshnessThresholdMinutes =
    settings.advanced.doctorFreshnessThresholdMinutes;
  groupedConfig.doctor.degradedRateThreshold = settings.advanced.doctorDegradedRateThreshold;
  groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount =
    settings.advanced.doctorKnowledgeZeroUseWarningMinActiveCount;
  process.env.BRAVE_SEARCH_API_KEY = secrets.braveApiKey?.value ?? "";
  process.env[projectEnvKey("EXA_API_KEY")] = secrets.exaApiKey?.value ?? "";
}

export function buildRuntimeSettingsView(
  settings: RuntimeSettingsEditable,
  secretStatuses: {
    openaiApiKey: RuntimeSecretStatus;
    azureOpenAiApiKey: RuntimeSecretStatus;
    azureOpenAiApiKeys?: RuntimeSecretStatus[];
    localLlmApiKey: RuntimeSecretStatus;
    localLlmApiKeys?: RuntimeSecretStatus[];
    braveApiKey: RuntimeSecretStatus;
    exaApiKey: RuntimeSecretStatus;
    bedrockCredential: RuntimeSecretStatus;
  },
): RuntimeSettingsView {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      openai: { ...settings.providers.openai, apiKeySecret: secretStatuses.openaiApiKey },
      "azure-openai": {
        ...settings.providers["azure-openai"],
        apiKeySecret: secretStatuses.azureOpenAiApiKey,
        apiKeySecrets:
          secretStatuses.azureOpenAiApiKeys ??
          settings.providers["azure-openai"].deployments.map((_, index) =>
            index === 0 ? secretStatuses.azureOpenAiApiKey : emptyRuntimeSecretStatus(),
          ),
      },
      bedrock: {
        ...settings.providers.bedrock,
        credentialSecret: secretStatuses.bedrockCredential,
      },
      "local-llm": {
        ...settings.providers["local-llm"],
        apiKeySecret: secretStatuses.localLlmApiKey,
        apiKeySecrets:
          secretStatuses.localLlmApiKeys ??
          settings.providers["local-llm"].models.map((_, index) =>
            index === 0 ? secretStatuses.localLlmApiKey : emptyRuntimeSecretStatus(),
          ),
      },
    },
    search: {
      ...settings.search,
      providers: {
        ...settings.search.providers,
        brave: { ...settings.search.providers.brave, apiKeySecret: secretStatuses.braveApiKey },
        exa: { ...settings.search.providers.exa, apiKeySecret: secretStatuses.exaApiKey },
      },
    },
  };
}

export function buildSourceMap(view: RuntimeSettingsView): Record<string, string> {
  return {
    "distillationPriority.targetPriorityOrder": "db",
    "findCandidate.source.provider": "db",
    "findCandidate.vibe.provider": "db",
    "findCandidate.throttling": "db",
    "webSourceResearch.provider": "db",
    "coverEvidence.sourceSupport.provider": "db",
    "coverEvidence.externalEvidence.provider": "db",
    "coverEvidence.mcpEvidence.provider": "db",
    "findCandidate.timeoutMs": "db",
    "findCandidate.maxToolCalls": "db",
    "distillation.pipelineClaimLimit": "db",
    "findingQueue.taskIntervalSeconds": "db",
    "coveringQueue.taskIntervalSeconds": "db",
    "coverEvidence.timeoutMs": "db",
    "coverEvidence.searchMaxCalls": "db",
    "coverEvidence.fetchMaxCalls": "db",
    "agenticCompile.provider": "db",
    "openai.apiKey": view.providers.openai.apiKeySecret.source,
    "azure-openai.apiKey": view.providers["azure-openai"].apiKeySecret.source,
    "azure-openai.apiKey2": view.providers["azure-openai"].apiKeySecrets[1]?.source ?? "none",
    "azure-openai.apiKey3": view.providers["azure-openai"].apiKeySecrets[2]?.source ?? "none",
    "local-llm.apiKey": view.providers["local-llm"].apiKeySecret.source,
    "local-llm.apiKey2": view.providers["local-llm"].apiKeySecrets[1]?.source ?? "none",
    "local-llm.apiKey3": view.providers["local-llm"].apiKeySecrets[2]?.source ?? "none",
    "search.brave.apiKey": view.search.providers.brave.apiKeySecret.source,
    "search.exa.apiKey": view.search.providers.exa.apiKeySecret.source,
    "bedrock.credential": view.providers.bedrock.credentialSecret.source,
  };
}

export function defaultCache(): RuntimeSettingsCache {
  const defaults = cloneDefaultSettings();
  const secretStatuses = {
    openaiApiKey: {
      configured: Boolean(bootstrap.secrets.openaiApiKey),
      source: bootstrap.secrets.openaiApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.openaiApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey: {
      configured: Boolean(bootstrap.secrets.azureOpenAiApiKey),
      source: bootstrap.secrets.azureOpenAiApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.azureOpenAiApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey2: {
      configured: Boolean(bootstrap.secrets.azureOpenAiApiKey2),
      source: bootstrap.secrets.azureOpenAiApiKey2 ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.azureOpenAiApiKey2),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey3: {
      configured: Boolean(bootstrap.secrets.azureOpenAiApiKey3),
      source: bootstrap.secrets.azureOpenAiApiKey3 ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.azureOpenAiApiKey3),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKeys: bootstrap.providers["azure-openai"].deployments.map(
      (_deployment, index) => {
        const value =
          index === 0
            ? bootstrap.secrets.azureOpenAiApiKey
            : bootstrap.secrets[`azureOpenAiApiKey${index + 1}` as RuntimeSecretKey];
        return {
          configured: Boolean(value),
          source: value ? "env" : "none",
          maskedValue: maskSecret(value),
          updatedAt: null,
        } satisfies RuntimeSecretStatus;
      },
    ),
    localLlmApiKey: {
      configured: Boolean(bootstrap.secrets.localLlmApiKey),
      source: bootstrap.secrets.localLlmApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.localLlmApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    localLlmApiKeys: bootstrap.providers["local-llm"].models.map((_model, index) => {
      const value = bootstrap.secrets[localLlmSecretKey(index)];
      return {
        configured: Boolean(value),
        source: value ? "env" : "none",
        maskedValue: maskSecret(value),
        updatedAt: null,
      } satisfies RuntimeSecretStatus;
    }),
    braveApiKey: {
      configured: Boolean(bootstrap.secrets.braveApiKey),
      source: bootstrap.secrets.braveApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.braveApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    exaApiKey: {
      configured: Boolean(bootstrap.secrets.exaApiKey),
      source: bootstrap.secrets.exaApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.exaApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    bedrockCredential: resolveBedrockCredentialStatus(defaults),
  };
  const view = buildRuntimeSettingsView(defaults, secretStatuses);
  return {
    loadedAt: null,
    revision: 0,
    settings: defaults,
    view,
    sources: buildSourceMap(view),
  };
}
