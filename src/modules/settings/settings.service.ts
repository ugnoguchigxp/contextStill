import { APP_CONSTANTS } from "../../constants.js";
import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import {
  SETTINGS_DOCUMENT_KEY,
  SETTINGS_DOCUMENT_NAMESPACE,
  SETTINGS_SECRET_NAMESPACE,
  type SettingsRow,
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "./settings.repository.js";
import {
  type RuntimeProviderName,
  type RuntimeProviderSetting,
  type RuntimeSecretKey,
  type RuntimeSecretSource,
  type RuntimeSecretStatus,
  type RuntimeSettingsEditable,
  type RuntimeSettingsRoute,
  type RuntimeSettingsSecrets,
  type RuntimeSettingsUpdateRequest,
  type RuntimeSettingsView,
  runtimeProviderNames,
  runtimeSettingsEditableSchema,
} from "./settings.types.js";

const secretRowKeys: RuntimeSecretKey[] = [
  "openaiApiKey",
  "azureOpenAiApiKey",
  "localLlmApiKey",
  "braveApiKey",
  "exaApiKey",
];

type SecretValueEntry = {
  value: string;
  source: RuntimeSecretSource;
  updatedAt: string | null;
};

type RuntimeSettingsCache = {
  loadedAt: Date | null;
  revision: number;
  settings: RuntimeSettingsEditable;
  view: RuntimeSettingsView;
  sources: Record<string, string>;
};

type BootstrapConfig = {
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function maskSecret(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.max(4, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

function getSecretStringFromRow(row: SettingsRow | undefined): string | undefined {
  if (!row) return undefined;
  const record = asRecord(row.value);
  const direct = asString(record.value);
  return direct?.trim() ? direct.trim() : undefined;
}

const bootstrap: BootstrapConfig = {
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
  },
  taskRouting: {
    findCandidate: {
      source: { provider: "openai", model: groupedConfig.openAi.model, fallback: [] },
      vibe: { provider: "openai", model: groupedConfig.openAi.model, fallback: [] },
    },
    coverEvidence: {
      sourceSupport: { provider: "local-llm", model: groupedConfig.localLlm.model, fallback: [] },
      externalEvidence: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [],
      },
      mcpEvidence: { provider: "local-llm", model: groupedConfig.localLlm.model, fallback: [] },
    },
    finalizeDistille: { provider: "local-llm", model: groupedConfig.localLlm.model, fallback: [] },
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
    continuousIdleSleepMs: groupedConfig.distillation.continuousIdleSleepMs,
    continuousErrorSleepMs: groupedConfig.distillation.continuousErrorSleepMs,
    inventoryRefreshIntervalMs: groupedConfig.distillation.inventoryRefreshIntervalMs,
    doctorFreshnessThresholdMinutes: groupedConfig.doctor.freshnessThresholdMinutes,
    doctorDegradedRateThreshold: groupedConfig.doctor.degradedRateThreshold,
    doctorKnowledgeZeroUseWarningMinActiveCount:
      groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
  },
  secrets: {
    openaiApiKey: groupedConfig.openAi.apiKey.trim() || undefined,
    azureOpenAiApiKey: groupedConfig.azureOpenAi.apiKey.trim() || undefined,
    localLlmApiKey: groupedConfig.localLlm.apiKey.trim() || undefined,
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    exaApiKey:
      process.env.MEMORY_ROUTER_EXA_API_KEY?.trim() || process.env.EXA_API_KEY?.trim() || undefined,
  },
};

function cloneDefaultSettings(): RuntimeSettingsEditable {
  return {
    providers: {
      openai: { ...bootstrap.providers.openai },
      "azure-openai": { ...bootstrap.providers["azure-openai"] },
      bedrock: { ...bootstrap.providers.bedrock },
      "local-llm": { ...bootstrap.providers["local-llm"] },
    },
    taskRouting: {
      findCandidate: {
        source: { ...bootstrap.taskRouting.findCandidate.source },
        vibe: { ...bootstrap.taskRouting.findCandidate.vibe },
      },
      coverEvidence: {
        sourceSupport: { ...bootstrap.taskRouting.coverEvidence.sourceSupport },
        externalEvidence: { ...bootstrap.taskRouting.coverEvidence.externalEvidence },
        mcpEvidence: { ...bootstrap.taskRouting.coverEvidence.mcpEvidence },
      },
      finalizeDistille: { ...bootstrap.taskRouting.finalizeDistille },
      agenticCompile: {
        ...bootstrap.taskRouting.agenticCompile,
        fallback: [...bootstrap.taskRouting.agenticCompile.fallback],
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
  provider: RuntimeProviderSetting,
): string | undefined {
  if (provider === "auto") return undefined;
  switch (provider) {
    case "openai":
      return settings.providers.openai.model.trim() || undefined;
    case "azure-openai":
      return settings.providers["azure-openai"].model.trim() || undefined;
    case "bedrock":
      return settings.providers.bedrock.model.trim() || undefined;
    case "local-llm":
      return settings.providers["local-llm"].model.trim() || undefined;
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
  };
}

function mergeRuntimeSettings(
  defaults: RuntimeSettingsEditable,
  input: Record<string, unknown>,
): RuntimeSettingsEditable {
  const merged: RuntimeSettingsEditable = {
    ...defaults,
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

  merged.taskRouting.findCandidate.source = sanitizeRoute(
    merged,
    merged.taskRouting.findCandidate.source,
  );
  merged.taskRouting.findCandidate.vibe = sanitizeRoute(
    merged,
    merged.taskRouting.findCandidate.vibe,
  );
  merged.taskRouting.coverEvidence.sourceSupport = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.sourceSupport,
  );
  merged.taskRouting.coverEvidence.externalEvidence = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.externalEvidence,
  );
  merged.taskRouting.coverEvidence.mcpEvidence = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.mcpEvidence,
  );
  merged.taskRouting.finalizeDistille = sanitizeRoute(merged, merged.taskRouting.finalizeDistille);
  merged.taskRouting.agenticCompile.model =
    resolveConfiguredRouteModel(merged, merged.taskRouting.agenticCompile.provider) ??
    merged.taskRouting.agenticCompile.model?.trim() ??
    merged.providers.openai.model.trim();
  merged.taskRouting.agenticCompile.fallback = normalizeProviderList(
    merged.taskRouting.agenticCompile.fallback,
  );
  merged.search.providerOrder = [...new Set(merged.search.providerOrder)];
  return merged;
}

function parseDocumentValue(row: SettingsRow | null): RuntimeSettingsEditable {
  const defaults = cloneDefaultSettings();
  if (!row) return defaults;
  const root = asRecord(row.value);
  const raw = asRecord(root.settings ?? root);
  const merged = mergeRuntimeSettings(defaults, raw);
  const parsed = runtimeSettingsEditableSchema.safeParse(merged);
  if (!parsed.success) {
    return defaults;
  }
  return parsed.data;
}

function buildSecretMap(rows: SettingsRow[]): Record<RuntimeSecretKey, SettingsRow | undefined> {
  const result = Object.create(null) as Record<RuntimeSecretKey, SettingsRow | undefined>;
  for (const key of secretRowKeys) {
    result[key] = rows.find((row) => row.key === key);
  }
  return result;
}

function resolveSecretValue(
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

function resolveBedrockCredentialStatus(settings: RuntimeSettingsEditable): RuntimeSecretStatus {
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

function applyRuntimeSettingsToProcess(
  settings: RuntimeSettingsEditable,
  secrets: Record<RuntimeSecretKey, SecretValueEntry | null>,
): void {
  groupedConfig.openAi.apiBaseUrl = settings.providers.openai.apiBaseUrl.replace(/\/+$/, "");
  groupedConfig.openAi.model = settings.providers.openai.model;
  groupedConfig.openAi.apiKey = secrets.openaiApiKey?.value ?? "";

  groupedConfig.azureOpenAi.apiBaseUrl = settings.providers["azure-openai"].apiBaseUrl.replace(
    /\/+$/,
    "",
  );
  groupedConfig.azureOpenAi.apiPath = settings.providers["azure-openai"].apiPath;
  groupedConfig.azureOpenAi.apiVersion = settings.providers["azure-openai"].apiVersion;
  groupedConfig.azureOpenAi.model = settings.providers["azure-openai"].model;
  groupedConfig.azureOpenAi.apiKey = secrets.azureOpenAiApiKey?.value ?? "";

  groupedConfig.bedrock.region = settings.providers.bedrock.region;
  groupedConfig.bedrock.profile = settings.providers.bedrock.profile;
  groupedConfig.bedrock.model = settings.providers.bedrock.model;

  groupedConfig.localLlm.apiBaseUrl = settings.providers["local-llm"].apiBaseUrl.replace(
    /\/+$/,
    "",
  );
  groupedConfig.localLlm.model = settings.providers["local-llm"].model;
  groupedConfig.localLlm.apiKey = secrets.localLlmApiKey?.value ?? "";

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
  groupedConfig.distillation.timeoutMs = settings.distillationRuntime.timeoutMs;
  groupedConfig.distillation.candidateTimeoutMs = settings.distillationRuntime.candidateTimeoutMs;
  groupedConfig.distillation.lowImportanceRejectThreshold =
    settings.distillationRuntime.lowImportanceRejectThreshold;
  groupedConfig.distillation.lockTtlSeconds = settings.advanced.lockTtlSeconds;
  groupedConfig.distillation.pipelineLockStaleSeconds = settings.advanced.pipelineLockStaleSeconds;
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
  process.env.MEMORY_ROUTER_EXA_API_KEY = secrets.exaApiKey?.value ?? "";
}

function buildRuntimeSettingsView(
  settings: RuntimeSettingsEditable,
  secretStatuses: {
    openaiApiKey: RuntimeSecretStatus;
    azureOpenAiApiKey: RuntimeSecretStatus;
    localLlmApiKey: RuntimeSecretStatus;
    braveApiKey: RuntimeSecretStatus;
    exaApiKey: RuntimeSecretStatus;
    bedrockCredential: RuntimeSecretStatus;
  },
): RuntimeSettingsView {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      openai: {
        ...settings.providers.openai,
        apiKeySecret: secretStatuses.openaiApiKey,
      },
      "azure-openai": {
        ...settings.providers["azure-openai"],
        apiKeySecret: secretStatuses.azureOpenAiApiKey,
      },
      bedrock: {
        ...settings.providers.bedrock,
        credentialSecret: secretStatuses.bedrockCredential,
      },
      "local-llm": {
        ...settings.providers["local-llm"],
        apiKeySecret: secretStatuses.localLlmApiKey,
      },
    },
    search: {
      ...settings.search,
      providers: {
        ...settings.search.providers,
        brave: {
          ...settings.search.providers.brave,
          apiKeySecret: secretStatuses.braveApiKey,
        },
        exa: {
          ...settings.search.providers.exa,
          apiKeySecret: secretStatuses.exaApiKey,
        },
      },
    },
  };
}

function buildSourceMap(view: RuntimeSettingsView): Record<string, string> {
  return {
    "findCandidate.source.provider": "db",
    "findCandidate.vibe.provider": "db",
    "coverEvidence.sourceSupport.provider": "db",
    "coverEvidence.externalEvidence.provider": "db",
    "coverEvidence.mcpEvidence.provider": "db",
    "agenticCompile.provider": "db",
    "openai.apiKey": view.providers.openai.apiKeySecret.source,
    "azure-openai.apiKey": view.providers["azure-openai"].apiKeySecret.source,
    "local-llm.apiKey": view.providers["local-llm"].apiKeySecret.source,
    "search.brave.apiKey": view.search.providers.brave.apiKeySecret.source,
    "search.exa.apiKey": view.search.providers.exa.apiKeySecret.source,
    "bedrock.credential": view.providers.bedrock.credentialSecret.source,
  };
}

function defaultCache(): RuntimeSettingsCache {
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
    localLlmApiKey: {
      configured: Boolean(bootstrap.secrets.localLlmApiKey),
      source: bootstrap.secrets.localLlmApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.localLlmApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
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

let runtimeSettingsCache: RuntimeSettingsCache = defaultCache();
let loadingPromise: Promise<void> | null = null;

async function loadRuntimeSettingsInternal(): Promise<void> {
  const [documentRow, secretRows] = await Promise.all([
    findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY),
    listSettingsRows(SETTINGS_SECRET_NAMESPACE),
  ]);

  const settings = parseDocumentValue(documentRow);
  const secretRowMap = buildSecretMap(secretRows);
  const resolvedSecrets = {
    openaiApiKey: resolveSecretValue("openaiApiKey", secretRowMap.openaiApiKey),
    azureOpenAiApiKey: resolveSecretValue("azureOpenAiApiKey", secretRowMap.azureOpenAiApiKey),
    localLlmApiKey: resolveSecretValue("localLlmApiKey", secretRowMap.localLlmApiKey),
    braveApiKey: resolveSecretValue("braveApiKey", secretRowMap.braveApiKey),
    exaApiKey: resolveSecretValue("exaApiKey", secretRowMap.exaApiKey),
  };

  const secretStatuses = {
    openaiApiKey: {
      configured: Boolean(resolvedSecrets.openaiApiKey?.value),
      source: resolvedSecrets.openaiApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.openaiApiKey?.value),
      updatedAt: resolvedSecrets.openaiApiKey?.updatedAt ?? null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey: {
      configured: Boolean(resolvedSecrets.azureOpenAiApiKey?.value),
      source: resolvedSecrets.azureOpenAiApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.azureOpenAiApiKey?.value),
      updatedAt: resolvedSecrets.azureOpenAiApiKey?.updatedAt ?? null,
    } satisfies RuntimeSecretStatus,
    localLlmApiKey: {
      configured: Boolean(resolvedSecrets.localLlmApiKey?.value),
      source: resolvedSecrets.localLlmApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.localLlmApiKey?.value),
      updatedAt: resolvedSecrets.localLlmApiKey?.updatedAt ?? null,
    } satisfies RuntimeSecretStatus,
    braveApiKey: {
      configured: Boolean(resolvedSecrets.braveApiKey?.value),
      source: resolvedSecrets.braveApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.braveApiKey?.value),
      updatedAt: resolvedSecrets.braveApiKey?.updatedAt ?? null,
    } satisfies RuntimeSecretStatus,
    exaApiKey: {
      configured: Boolean(resolvedSecrets.exaApiKey?.value),
      source: resolvedSecrets.exaApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.exaApiKey?.value),
      updatedAt: resolvedSecrets.exaApiKey?.updatedAt ?? null,
    } satisfies RuntimeSecretStatus,
    bedrockCredential: resolveBedrockCredentialStatus(settings),
  };

  applyRuntimeSettingsToProcess(settings, resolvedSecrets);

  const view = buildRuntimeSettingsView(settings, secretStatuses);
  runtimeSettingsCache = {
    loadedAt: new Date(),
    revision: documentRow?.schemaVersion ?? 0,
    settings,
    view,
    sources: buildSourceMap(view),
  };
}

export async function ensureRuntimeSettingsLoaded(): Promise<void> {
  if (runtimeSettingsCache.loadedAt) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }
  loadingPromise = loadRuntimeSettingsInternal()
    .catch(() => {
      const fallback = defaultCache();
      applyRuntimeSettingsToProcess(fallback.settings, {
        openaiApiKey: fallback.view.providers.openai.apiKeySecret.configured
          ? {
              value: bootstrap.secrets.openaiApiKey ?? "",
              source: "env",
              updatedAt: null,
            }
          : null,
        azureOpenAiApiKey: fallback.view.providers["azure-openai"].apiKeySecret.configured
          ? {
              value: bootstrap.secrets.azureOpenAiApiKey ?? "",
              source: "env",
              updatedAt: null,
            }
          : null,
        localLlmApiKey: fallback.view.providers["local-llm"].apiKeySecret.configured
          ? {
              value: bootstrap.secrets.localLlmApiKey ?? "",
              source: "env",
              updatedAt: null,
            }
          : null,
        braveApiKey: fallback.view.search.providers.brave.apiKeySecret.configured
          ? {
              value: bootstrap.secrets.braveApiKey ?? "",
              source: "env",
              updatedAt: null,
            }
          : null,
        exaApiKey: fallback.view.search.providers.exa.apiKeySecret.configured
          ? {
              value: bootstrap.secrets.exaApiKey ?? "",
              source: "env",
              updatedAt: null,
            }
          : null,
      });
      runtimeSettingsCache = { ...fallback, loadedAt: new Date() };
    })
    .finally(() => {
      loadingPromise = null;
    });
  await loadingPromise;
}

export function getRuntimeSettingsSnapshot(): RuntimeSettingsEditable {
  return runtimeSettingsCache.settings;
}

export function getRuntimeSettingsViewSnapshot(): {
  settings: RuntimeSettingsView;
  effective: RuntimeSettingsView;
  sources: Record<string, string>;
  revision: number;
  loadedAt: string | null;
} {
  return {
    settings: runtimeSettingsCache.view,
    effective: runtimeSettingsCache.view,
    sources: runtimeSettingsCache.sources,
    revision: runtimeSettingsCache.revision,
    loadedAt: runtimeSettingsCache.loadedAt?.toISOString() ?? null,
  };
}

export function invalidateRuntimeSettingsCache(): void {
  runtimeSettingsCache = defaultCache();
}

export async function reloadRuntimeSettingsCache(): Promise<void> {
  invalidateRuntimeSettingsCache();
  await ensureRuntimeSettingsLoaded();
}

function normalizeSecretKey(value: string): RuntimeSecretKey | null {
  return secretRowKeys.includes(value as RuntimeSecretKey) ? (value as RuntimeSecretKey) : null;
}

export async function saveRuntimeSettings(
  input: RuntimeSettingsUpdateRequest,
): Promise<{ revision: number; updatedAt: string }> {
  const parsed = runtimeSettingsEditableSchema.parse(input.settings);
  const existing = await findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY);
  const nextRevision = Math.max(1, (existing?.schemaVersion ?? 0) + 1);

  const written = await upsertSettingsRow({
    namespace: SETTINGS_DOCUMENT_NAMESPACE,
    key: SETTINGS_DOCUMENT_KEY,
    value: { settings: parsed },
    schemaVersion: nextRevision,
    updatedBy: input.updatedBy ?? null,
    description: "Runtime settings control-plane document",
    valueKind: "json",
  });

  if (input.secrets) {
    for (const [rawKey, update] of Object.entries(input.secrets)) {
      const key = normalizeSecretKey(rawKey);
      if (!key) continue;
      if (update.clear) {
        await deleteSettingsRow(SETTINGS_SECRET_NAMESPACE, key);
        continue;
      }
      const value = update.value?.trim();
      if (!value) continue;
      await upsertSettingsRow({
        namespace: SETTINGS_SECRET_NAMESPACE,
        key,
        value: { value },
        schemaVersion: nextRevision,
        updatedBy: input.updatedBy ?? null,
        description: `Secret for ${key}`,
        valueKind: "encrypted",
        isSecret: true,
      });
    }
  }

  await reloadRuntimeSettingsCache();
  return {
    revision: written.schemaVersion,
    updatedAt: written.updatedAt.toISOString(),
  };
}

export function resolveFindCandidateRoute(
  targetKind: "wiki_file" | "vibe_memory",
): RuntimeSettingsRoute {
  return targetKind === "vibe_memory"
    ? runtimeSettingsCache.settings.taskRouting.findCandidate.vibe
    : runtimeSettingsCache.settings.taskRouting.findCandidate.source;
}

export function resolveCoverEvidenceRoutes(): {
  sourceSupport: RuntimeSettingsRoute;
  externalEvidence: RuntimeSettingsRoute;
  mcpEvidence: RuntimeSettingsRoute;
} {
  return runtimeSettingsCache.settings.taskRouting.coverEvidence;
}

export function resolveAgenticCompileRouting(): RuntimeSettingsEditable["taskRouting"]["agenticCompile"] {
  return runtimeSettingsCache.settings.taskRouting.agenticCompile;
}

export function buildDefaultSettingsForSeed(): RuntimeSettingsEditable {
  const defaults = cloneDefaultSettings();
  defaults.distillationRuntime.toolTimeoutMs = APP_CONSTANTS.distillationToolTimeoutMs;
  defaults.search.timeoutMs = APP_CONSTANTS.distillationToolTimeoutMs;
  return defaults;
}
