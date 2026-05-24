import { z } from "zod";
import type { DistillationSearchProvider, EmbeddingProvider } from "../../config.types.js";

export const runtimeProviderNames = ["openai", "azure-openai", "bedrock", "local-llm"] as const;
export type RuntimeProviderName = (typeof runtimeProviderNames)[number];

export const runtimeProviderSettingNames = [...runtimeProviderNames, "auto"] as const;
export type RuntimeProviderSetting = (typeof runtimeProviderSettingNames)[number];

export type RuntimeSecretKey =
  | "openaiApiKey"
  | "azureOpenAiApiKey"
  | "localLlmApiKey"
  | "braveApiKey"
  | "exaApiKey";

export const runtimeSecretKeys = [
  "openaiApiKey",
  "azureOpenAiApiKey",
  "localLlmApiKey",
  "braveApiKey",
  "exaApiKey",
] as const;

export type RuntimeSecretSource = "db" | "env" | "none" | "env-or-profile";

export type RuntimeSecretStatus = {
  configured: boolean;
  source: RuntimeSecretSource;
  maskedValue: string | null;
  updatedAt: string | null;
};

export type RuntimeSettingsRoute = {
  provider: RuntimeProviderSetting;
  model?: string;
  fallback: RuntimeProviderName[];
};

export const distillationPriorityTargetKindValues = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
] as const;

export type DistillationPriorityTargetKind = (typeof distillationPriorityTargetKindValues)[number];

export type RuntimeSettingsEditable = {
  general: {
    distillationPriority: {
      targetPriorityOrder: DistillationPriorityTargetKind[];
    };
  };
  providers: {
    openai: {
      enabled: boolean;
      apiBaseUrl: string;
      model: string;
    };
    "azure-openai": {
      enabled: boolean;
      apiBaseUrl: string;
      apiPath: string;
      apiVersion: string;
      model: string;
    };
    bedrock: {
      enabled: boolean;
      region: string;
      profile: string;
      model: string;
    };
    "local-llm": {
      enabled: boolean;
      apiBaseUrl: string;
      model: string;
    };
  };
  taskRouting: {
    findCandidate: {
      source: RuntimeSettingsRoute;
      vibe: RuntimeSettingsRoute;
    };
    webSourceResearch: RuntimeSettingsRoute;
    coverEvidence: {
      sourceSupport: RuntimeSettingsRoute;
      externalEvidence: RuntimeSettingsRoute;
      mcpEvidence: RuntimeSettingsRoute;
    };
    finalizeDistille: RuntimeSettingsRoute;
    agenticCompile: {
      enabled: boolean;
      provider: RuntimeProviderName;
      model: string;
      fallback: RuntimeProviderName[];
      timeoutMs: number;
      maxTokens: number;
    };
  };
  search: {
    providerOrder: DistillationSearchProvider[];
    maxProviderAttempts: number;
    resultCount: number;
    timeoutMs: number;
    rateLimitCooldownSeconds: number;
    providers: {
      brave: { enabled: boolean };
      exa: { enabled: boolean };
      duckduckgo: { enabled: boolean };
    };
  };
  embedding: {
    provider: EmbeddingProvider;
    daemonUrl: string;
    openaiModel: string;
    timeoutMs: number;
  };
  distillationRuntime: {
    timeoutMs: number;
    candidateTimeoutMs: number;
    maxToolRounds: number;
    toolTimeoutMs: number;
    toolResultMaxChars: number;
    failureRetryDelaySeconds: number;
    readerMaxReads: number;
    readerMaxCharsPerRead: number;
    lowImportanceRejectThreshold: number;
  };
  advanced: {
    pipelineLockStaleSeconds: number;
    lockTtlSeconds: number;
    continuousIdleSleepMs: number;
    continuousErrorSleepMs: number;
    inventoryRefreshIntervalMs: number;
    doctorFreshnessThresholdMinutes: number;
    doctorDegradedRateThreshold: number;
    doctorKnowledgeZeroUseWarningMinActiveCount: number;
    codexLogSyncEnabled: boolean;
    antigravityLogSyncEnabled: boolean;
    claudeLogSyncEnabled: boolean;
  };
};

export type RuntimeSettingsView = RuntimeSettingsEditable & {
  providers: RuntimeSettingsEditable["providers"] & {
    openai: RuntimeSettingsEditable["providers"]["openai"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
    "azure-openai": RuntimeSettingsEditable["providers"]["azure-openai"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
    bedrock: RuntimeSettingsEditable["providers"]["bedrock"] & {
      credentialSecret: RuntimeSecretStatus;
    };
    "local-llm": RuntimeSettingsEditable["providers"]["local-llm"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
  };
  search: RuntimeSettingsEditable["search"] & {
    providers: RuntimeSettingsEditable["search"]["providers"] & {
      brave: RuntimeSettingsEditable["search"]["providers"]["brave"] & {
        apiKeySecret: RuntimeSecretStatus;
      };
      exa: RuntimeSettingsEditable["search"]["providers"]["exa"] & {
        apiKeySecret: RuntimeSecretStatus;
      };
    };
  };
};

export type RuntimeSettingsSecrets = Partial<Record<RuntimeSecretKey, string>>;

const runtimeProviderSchema = z.enum(runtimeProviderNames);
const runtimeProviderSettingSchema = z.enum(runtimeProviderSettingNames);
const searchProviderSchema = z.enum(["brave", "exa", "duckduckgo"] as const);

const runtimeRouteSchema = z.object({
  provider: runtimeProviderSettingSchema,
  model: z.string().trim().min(1).optional(),
  fallback: z.array(runtimeProviderSchema).max(8).default([]),
});

export const runtimeSettingsEditableSchema = z.object({
  general: z.object({
    distillationPriority: z.object({
      targetPriorityOrder: z.array(z.enum(distillationPriorityTargetKindValues)).min(1).max(4),
    }),
  }),
  providers: z.object({
    openai: z.object({
      enabled: z.boolean().default(true),
      apiBaseUrl: z.string().trim().url(),
      model: z.string().trim().min(1),
    }),
    "azure-openai": z.object({
      enabled: z.boolean().default(false),
      apiBaseUrl: z.string().trim().url().or(z.literal("")),
      apiPath: z.string().trim().min(1),
      apiVersion: z.string().trim().min(1),
      model: z.string().trim().min(1).or(z.literal("")),
    }),
    bedrock: z.object({
      enabled: z.boolean().default(false),
      region: z.string().trim().min(1),
      profile: z.string().trim(),
      model: z.string().trim().min(1).or(z.literal("")),
    }),
    "local-llm": z.object({
      enabled: z.boolean().default(true),
      apiBaseUrl: z.string().trim().url(),
      model: z.string().trim().min(1),
    }),
  }),
  taskRouting: z.object({
    findCandidate: z.object({
      source: runtimeRouteSchema,
      vibe: runtimeRouteSchema,
    }),
    webSourceResearch: runtimeRouteSchema,
    coverEvidence: z.object({
      sourceSupport: runtimeRouteSchema,
      externalEvidence: runtimeRouteSchema,
      mcpEvidence: runtimeRouteSchema,
    }),
    finalizeDistille: runtimeRouteSchema,
    agenticCompile: z.object({
      enabled: z.boolean().default(true),
      provider: runtimeProviderSchema,
      model: z.string().trim().min(1),
      fallback: z.array(runtimeProviderSchema).max(8).default([]),
      timeoutMs: z.number().int().min(1000).max(3_600_000),
      maxTokens: z.number().int().min(128).max(16_384),
    }),
  }),
  search: z.object({
    providerOrder: z.array(searchProviderSchema).min(1).max(3),
    maxProviderAttempts: z.number().int().min(1).max(3),
    resultCount: z.number().int().min(1).max(10),
    timeoutMs: z.number().int().min(1000).max(120_000),
    rateLimitCooldownSeconds: z.number().int().min(30).max(172_800),
    providers: z.object({
      brave: z.object({ enabled: z.boolean().default(true) }),
      exa: z.object({ enabled: z.boolean().default(true) }),
      duckduckgo: z.object({ enabled: z.boolean().default(true) }),
    }),
  }),
  embedding: z.object({
    provider: z.enum(["auto", "daemon", "cli", "openai", "disabled"] as const),
    daemonUrl: z.string().trim().url(),
    openaiModel: z.string().trim().min(1),
    timeoutMs: z.number().int().min(1000).max(120_000),
  }),
  distillationRuntime: z.object({
    timeoutMs: z.number().int().min(1000).max(3_600_000),
    candidateTimeoutMs: z.number().int().min(1000).max(3_600_000),
    maxToolRounds: z.number().int().min(0).max(64),
    toolTimeoutMs: z.number().int().min(1000).max(120_000),
    toolResultMaxChars: z.number().int().min(512).max(200_000),
    failureRetryDelaySeconds: z.number().int().min(1).max(604_800),
    readerMaxReads: z.number().int().min(1).max(64),
    readerMaxCharsPerRead: z.number().int().min(128).max(200_000),
    lowImportanceRejectThreshold: z.number().min(0).max(100),
  }),
  advanced: z.object({
    pipelineLockStaleSeconds: z.number().int().min(30).max(604_800),
    lockTtlSeconds: z.number().int().min(30).max(604_800),
    continuousIdleSleepMs: z.number().int().min(100).max(3_600_000),
    continuousErrorSleepMs: z.number().int().min(100).max(3_600_000),
    inventoryRefreshIntervalMs: z.number().int().min(100).max(3_600_000),
    doctorFreshnessThresholdMinutes: z.number().int().min(1).max(43_200),
    doctorDegradedRateThreshold: z.number().min(0).max(1),
    doctorKnowledgeZeroUseWarningMinActiveCount: z.number().int().min(1).max(100_000),
    codexLogSyncEnabled: z.boolean().default(true),
    antigravityLogSyncEnabled: z.boolean().default(true),
    claudeLogSyncEnabled: z.boolean().default(true),
  }),
});

export const runtimeSecretUpdateSchema = z
  .object({
    value: z.string().optional(),
    clear: z.boolean().optional(),
  })
  .refine((value) => value.clear === true || typeof value.value === "string", {
    message: "value または clear=true のどちらかが必要です",
  });

export const settingsUpdateRequestSchema = z.object({
  settings: runtimeSettingsEditableSchema,
  secrets: z.record(runtimeSecretUpdateSchema).optional(),
  updatedBy: z.string().trim().max(120).optional(),
});

export type RuntimeSettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;
