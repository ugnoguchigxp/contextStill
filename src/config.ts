import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import type {
  AgenticCompileProvider,
  DistillationSearchProvider,
  DistillationProvider,
  EmbeddingProvider,
  GroupedConfig,
} from "./config.types.js";
import { APP_CONSTANTS } from "./constants.js";

loadEnv({ quiet: true });

const distillationSearchProviderValues = new Set<DistillationSearchProvider>([
  "brave",
  "exa",
  "duckduckgo",
]);

const parseDistillationSearchProviders = (
  value: string | undefined,
  fallback: readonly DistillationSearchProvider[],
): DistillationSearchProvider[] => {
  if (value === undefined || value.trim() === "") return [...fallback];
  const parsed = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is DistillationSearchProvider =>
      distillationSearchProviderValues.has(part as DistillationSearchProvider),
    );
  if (parsed.length === 0) return [...fallback];
  return [...new Set(parsed)];
};

const parseDistillationProvider = (
  value: string | undefined,
  fallback: DistillationProvider,
): DistillationProvider => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "local-llm" ||
    normalized === "azure-openai" ||
    normalized === "bedrock" ||
    normalized === "auto"
  ) {
    return normalized;
  }
  return fallback;
};

const sourceContentRoot = path.resolve(process.cwd(), "wiki");
const readFileRoot = path.resolve(sourceContentRoot, "pages");

export const groupedConfig: GroupedConfig = {
  database: {
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:7889/memory_router",
  },
  embedding: {
    dimension: APP_CONSTANTS.embeddingDimension,
    provider: (process.env.MEMORY_ROUTER_EMBEDDING_PROVIDER || "auto") as EmbeddingProvider,
    daemonUrl: (process.env.MEMORY_ROUTER_EMBEDDING_DAEMON_URL || "http://127.0.0.1:44512").replace(
      /\/+$/,
      "",
    ),
    accessToken:
      process.env.MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    timeoutMs: APP_CONSTANTS.embeddingTimeoutMs,
    openaiModel: process.env.MEMORY_ROUTER_EMBEDDING_OPENAI_MODEL || "text-embedding-3-small",
  },
  localLlm: {
    embeddingRoot: path.resolve(process.cwd(), "../local-llm/embedding"),
    embeddingPython: path.resolve(process.cwd(), "../local-llm/embedding/.venv/bin/python"),
    embeddingModelDir: path.resolve(
      process.cwd(),
      "../local-llm/embedding/models/multilingual-e5-small",
    ),
    apiBaseUrl: (
      process.env.MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL || "http://127.0.0.1:44448"
    ).replace(/\/+$/, ""),
    apiKey: process.env.MEMORY_ROUTER_LOCAL_LLM_API_KEY || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    model: "gemma-4-e4b-it",
  },
  sourceContent: {
    root: sourceContentRoot,
  },
  readFile: {
    root: readFileRoot,
    defaultTokens: APP_CONSTANTS.readFileDefaultTokens,
    maxTokens: APP_CONSTANTS.readFileMaxTokens,
  },
  codex: {
    sessionDir:
      process.env.MEMORY_ROUTER_CODEX_SESSION_DIR || path.join(os.homedir(), ".codex", "sessions"),
    archivedSessionDir:
      process.env.MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIR ||
      path.join(os.homedir(), ".codex", "archived_sessions"),
  },
  antigravity: {
    logDir:
      process.env.MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR ||
      path.join(os.homedir(), ".gemini", "antigravity", "brain"),
    initialLookbackHours: APP_CONSTANTS.antigravityLogInitialLookbackHours,
  },
  agentLogSync: {
    intervalSeconds: APP_CONSTANTS.agentLogSyncIntervalSeconds,
    initialLookbackHours: APP_CONSTANTS.agentLogInitialLookbackHours,
    maxMessagesPerChunk: APP_CONSTANTS.agentLogMaxMessagesPerChunk,
    maxCharsPerChunk: APP_CONSTANTS.agentLogMaxCharsPerChunk,
    lockTtlSeconds: APP_CONSTANTS.agentLogSyncLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "agent-log-sync.lock"),
  },
  vibeDistillation: {
    promptVersion: APP_CONSTANTS.vibeDistillationPromptVersion,
    batchSize: APP_CONSTANTS.vibeDistillationBatchSize,
    maxInputChars: APP_CONSTANTS.vibeDistillationMaxInputChars,
    maxOutputTokens: APP_CONSTANTS.vibeDistillationMaxOutputTokens,
    lockTtlSeconds: APP_CONSTANTS.vibeDistillationLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "vibe-distillation.lock"),
  },
  sourceDistillation: {
    promptVersion: APP_CONSTANTS.sourceDistillationPromptVersion,
    batchSize: APP_CONSTANTS.sourceDistillationBatchSize,
    maxInputChars: APP_CONSTANTS.sourceDistillationMaxInputChars,
    maxOutputTokens: APP_CONSTANTS.sourceDistillationMaxOutputTokens,
    lockTtlSeconds: APP_CONSTANTS.sourceDistillationLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "source-distillation.lock"),
  },
  distillationTools: {
    maxRounds: APP_CONSTANTS.distillationToolMaxRounds,
    timeoutMs: APP_CONSTANTS.distillationToolTimeoutMs,
    resultMaxChars: APP_CONSTANTS.distillationToolResultMaxChars,
    searchResultCount: APP_CONSTANTS.distillationSearchResultCount,
    searchProviders: parseDistillationSearchProviders(
      process.env.MEMORY_ROUTER_DISTILLATION_SEARCH_PROVIDERS,
      APP_CONSTANTS.distillationSearchProviders,
    ),
    searchMaxProviderAttempts: APP_CONSTANTS.distillationSearchMaxProviderAttempts,
    searchRateLimitCooldownSeconds: APP_CONSTANTS.distillationSearchRateLimitCooldownSeconds,
    maxCandidates: APP_CONSTANTS.distillationMaxCandidates,
    failureRetryDelaySeconds: APP_CONSTANTS.distillationFailureRetryDelaySeconds,
    evidenceCacheTtlSeconds: APP_CONSTANTS.distillationEvidenceCacheTtlSeconds,
    readerMaxReads: APP_CONSTANTS.distillationReaderMaxReads,
    readerMaxCharsPerRead: APP_CONSTANTS.distillationReaderMaxCharsPerRead,
  },
  compile: {
    defaultTokenBudget: APP_CONSTANTS.defaultTokenBudget,
    enableVectorSearch: APP_CONSTANTS.enableVectorSearch,
  },
  azureOpenAi: {
    apiKey:
      process.env.MEMORY_ROUTER_AZURE_OPENAI_API_KEY ||
      process.env.AZURE_OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
    apiBaseUrl: (
      process.env.MEMORY_ROUTER_AZURE_OPENAI_API_BASE_URL ||
      process.env.AZURE_OPENAI_API_BASE_URL ||
      process.env.AZURE_OPENAI_ENDPOINT ||
      process.env.GNOSIS_REVIEW_LLM_API_BASE_URL ||
      ""
    ).replace(/\/+$/, ""),
    apiPath: "/openai/deployments",
    apiVersion:
      process.env.MEMORY_ROUTER_AZURE_OPENAI_API_VERSION ||
      process.env.AZURE_OPENAI_API_VERSION ||
      "2025-04-01-preview",
    model:
      process.env.MEMORY_ROUTER_AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_MODEL || "gpt-4o",
  },
  bedrock: {
    model: "",
    region: process.env.MEMORY_ROUTER_BEDROCK_REGION || process.env.AWS_REGION || "us-east-1",
    profile: process.env.MEMORY_ROUTER_BEDROCK_PROFILE || process.env.AWS_PROFILE || "",
  },
  agenticCompile: {
    provider: "azure-openai",
    enabled: APP_CONSTANTS.agenticCompileEnabled,
    timeoutMs: APP_CONSTANTS.agenticCompileTimeoutMs,
    maxTokens: APP_CONSTANTS.agenticCompileMaxTokens,
  },
  distillation: {
    provider: parseDistillationProvider(
      process.env.MEMORY_ROUTER_DISTILLATION_PROVIDER,
      "local-llm",
    ),
    legacyEnabled: APP_CONSTANTS.distillationLegacyEnabled,
    timeoutMs: APP_CONSTANTS.distillationTimeoutMs,
    lockTtlSeconds: APP_CONSTANTS.distillationLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "distillation.lock"),
    promotionBacklogThresholdCount: APP_CONSTANTS.distillationPromotionBacklogThresholdCount,
    minCandidateImportance: APP_CONSTANTS.distillationMinCandidateImportance,
    circuitBreakerEnabled: APP_CONSTANTS.distillationCircuitBreakerEnabled,
    circuitBreakerHealthTimeoutMs: APP_CONSTANTS.distillationCircuitBreakerHealthTimeoutMs,
    circuitBreakerPauseSeconds: APP_CONSTANTS.distillationCircuitBreakerPauseSeconds,
    backpressurePauseSeconds: APP_CONSTANTS.distillationBackpressurePauseSeconds,
    sourceAgenticReaderManualEnabled: APP_CONSTANTS.sourceDistillationAgenticReaderManualEnabled,
    sourceAgenticReaderAutoEnabled: APP_CONSTANTS.sourceDistillationAgenticReaderAutoEnabled,
    vibeAgenticReaderManualEnabled: APP_CONSTANTS.vibeDistillationAgenticReaderManualEnabled,
  },
  doctor: {
    freshnessThresholdMinutes: APP_CONSTANTS.doctorFreshnessThresholdMinutes,
    degradedRateThreshold: APP_CONSTANTS.doctorDegradedRateThreshold,
    knowledgeStaleDecayFactor: APP_CONSTANTS.doctorKnowledgeStaleDecayFactor,
    knowledgeZeroUseWarningMinActiveCount:
      APP_CONSTANTS.doctorKnowledgeZeroUseWarningMinActiveCount,
  },
};

export type {
  GroupedConfig,
  EmbeddingProvider,
  AgenticCompileProvider,
  DistillationProvider,
  DistillationSearchProvider,
};
