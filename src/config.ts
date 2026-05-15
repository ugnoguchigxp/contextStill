import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

const envBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const envNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

type EmbeddingProvider = "auto" | "daemon" | "cli" | "disabled";

type GroupedConfig = {
  database: { url: string };
  embedding: {
    dimension: number;
    provider: EmbeddingProvider;
    daemonUrl: string;
    accessToken: string;
    timeoutMs: number;
  };
  localLlm: {
    embeddingRoot: string;
    embeddingPython: string;
    embeddingModelDir: string;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  };
  sourceContent: { root: string };
  codex: { sessionDir: string; archivedSessionDir: string };
  antigravity: { logDir: string; initialLookbackHours: number };
  agentLogSync: {
    intervalSeconds: number;
    initialLookbackHours: number;
    maxMessagesPerChunk: number;
    maxCharsPerChunk: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  vibeDistillation: {
    promptVersion: string;
    batchSize: number;
    maxInputChars: number;
    maxOutputTokens: number;
    timeoutMs: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  sourceDistillation: {
    promptVersion: string;
    batchSize: number;
    maxInputChars: number;
    maxOutputTokens: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  distillationTools: {
    maxRounds: number;
    timeoutMs: number;
    resultMaxChars: number;
    searchResultCount: number;
    maxCandidates: number;
    minCandidateScore: number;
    failureRetryDelaySeconds: number;
  };
  compile: { defaultTokenBudget: number; enableVectorSearch: boolean };
  doctor: { freshnessThresholdMinutes: number; degradedRateThreshold: number };
};

export const groupedConfig: GroupedConfig = {
  database: {
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:7889/memory_router",
  },
  embedding: {
    dimension: Math.max(1, envNumber(process.env.MEMORY_ROUTER_EMBEDDING_DIMENSION, 384)),
    provider: (process.env.MEMORY_ROUTER_EMBEDDING_PROVIDER || "auto").trim() as EmbeddingProvider,
    daemonUrl: (process.env.MEMORY_ROUTER_EMBEDDING_DAEMON_URL || "http://127.0.0.1:44512").replace(
      /\/+$/,
      "",
    ),
    accessToken:
      process.env.MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    timeoutMs: Math.max(500, envNumber(process.env.MEMORY_ROUTER_EMBEDDING_TIMEOUT_MS, 10_000)),
  },
  localLlm: {
    embeddingRoot:
      process.env.MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_ROOT ||
      path.resolve(process.cwd(), "../local-llm/embedding"),
    embeddingPython:
      process.env.MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_PYTHON ||
      path.resolve(process.cwd(), "../local-llm/embedding/.venv/bin/python"),
    embeddingModelDir:
      process.env.MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_MODEL_DIR ||
      path.resolve(process.cwd(), "../local-llm/embedding/models/multilingual-e5-small"),
    apiBaseUrl: (
      process.env.MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL || "http://127.0.0.1:44448"
    ).replace(/\/+$/, ""),
    apiKey: process.env.MEMORY_ROUTER_LOCAL_LLM_API_KEY || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    model: process.env.MEMORY_ROUTER_LOCAL_LLM_MODEL || "gemma-4-e4b-it",
  },
  sourceContent: {
    root: process.env.MEMORY_ROUTER_SOURCE_CONTENT_ROOT || path.resolve(process.cwd(), "wiki"),
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
    initialLookbackHours: Math.max(
      0,
      envNumber(
        process.env.MEMORY_ROUTER_ANTIGRAVITY_LOG_INITIAL_LOOKBACK_HOURS,
        envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS, 24),
      ),
    ),
  },
  agentLogSync: {
    intervalSeconds: Math.max(
      60,
      envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS, 3600),
    ),
    initialLookbackHours: Math.max(
      0,
      envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS, 168),
    ),
    maxMessagesPerChunk: Math.max(
      1,
      envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_MAX_MESSAGES_PER_CHUNK, 120),
    ),
    maxCharsPerChunk: Math.max(
      512,
      envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_MAX_CHARS_PER_CHUNK, 12000),
    ),
    lockTtlSeconds: Math.max(
      60,
      envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_TTL_SECONDS, 1800),
    ),
    lockFile:
      process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_FILE ||
      path.resolve(process.cwd(), "logs", "agent-log-sync.lock"),
  },
  vibeDistillation: {
    promptVersion:
      process.env.MEMORY_ROUTER_VIBE_DISTILLATION_PROMPT_VERSION || "vibe-memory-rule-procedure-v1",
    batchSize: Math.max(1, envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_BATCH_SIZE, 10)),
    maxInputChars: Math.max(
      2048,
      envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_MAX_INPUT_CHARS, 12000),
    ),
    maxOutputTokens: Math.max(
      128,
      envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_MAX_OUTPUT_TOKENS, 2048),
    ),
    timeoutMs: Math.max(
      1000,
      envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS, 120_000),
    ),
    lockTtlSeconds: Math.max(
      60,
      envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_LOCK_TTL_SECONDS, 1800),
    ),
    lockFile:
      process.env.MEMORY_ROUTER_VIBE_DISTILLATION_LOCK_FILE ||
      path.resolve(process.cwd(), "logs", "vibe-distillation.lock"),
  },
  sourceDistillation: {
    promptVersion:
      process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_PROMPT_VERSION ||
      "source-wiki-rule-procedure-v1",
    batchSize: Math.max(1, envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_BATCH_SIZE, 10)),
    maxInputChars: Math.max(
      2048,
      envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_INPUT_CHARS, 12000),
    ),
    maxOutputTokens: Math.max(
      128,
      envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_OUTPUT_TOKENS, 2048),
    ),
    lockTtlSeconds: Math.max(
      60,
      envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_LOCK_TTL_SECONDS, 1800),
    ),
    lockFile:
      process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_LOCK_FILE ||
      path.resolve(process.cwd(), "logs", "source-distillation.lock"),
  },
  distillationTools: {
    maxRounds: Math.max(0, envNumber(process.env.MEMORY_ROUTER_DISTILLATION_TOOL_MAX_ROUNDS, 4)),
    timeoutMs: Math.max(
      1000,
      envNumber(process.env.MEMORY_ROUTER_DISTILLATION_TOOL_TIMEOUT_MS, 10_000),
    ),
    resultMaxChars: Math.max(
      1000,
      envNumber(process.env.MEMORY_ROUTER_DISTILLATION_TOOL_RESULT_MAX_CHARS, 6000),
    ),
    searchResultCount: Math.max(
      1,
      envNumber(process.env.MEMORY_ROUTER_DISTILLATION_SEARCH_RESULT_COUNT, 3),
    ),
    maxCandidates: Math.max(1, envNumber(process.env.MEMORY_ROUTER_DISTILLATION_MAX_CANDIDATES, 2)),
    minCandidateScore: Math.min(
      1,
      Math.max(0, envNumber(process.env.MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE, 0.75)),
    ),
    failureRetryDelaySeconds: Math.max(
      60,
      envNumber(process.env.MEMORY_ROUTER_DISTILLATION_FAILURE_RETRY_DELAY_SECONDS, 21600),
    ),
  },
  compile: {
    defaultTokenBudget: Math.max(
      256,
      envNumber(process.env.MEMORY_ROUTER_DEFAULT_TOKEN_BUDGET, 3000),
    ),
    enableVectorSearch: envBoolean(process.env.MEMORY_ROUTER_ENABLE_VECTOR_SEARCH, true),
  },
  doctor: {
    freshnessThresholdMinutes: Math.max(
      1,
      envNumber(process.env.MEMORY_ROUTER_DOCTOR_FRESHNESS_THRESHOLD_MINUTES, 720),
    ),
    degradedRateThreshold: Math.min(
      1,
      Math.max(0, envNumber(process.env.MEMORY_ROUTER_DOCTOR_DEGRADED_RATE_THRESHOLD, 0.5)),
    ),
  },
};

type FlatConfig = {
  databaseUrl: string;
  embeddingDimension: number;
  embeddingProvider: EmbeddingProvider;
  embeddingDaemonUrl: string;
  embeddingAccessToken: string;
  embeddingTimeoutMs: number;
  localLlmEmbeddingRoot: string;
  localLlmEmbeddingPython: string;
  localLlmEmbeddingModelDir: string;
  sourceContentRoot: string;
  codexSessionDir: string;
  codexArchivedSessionDir: string;
  antigravityLogDir: string;
  agentLogSyncIntervalSeconds: number;
  agentLogInitialLookbackHours: number;
  antigravityLogInitialLookbackHours: number;
  agentLogMaxMessagesPerChunk: number;
  agentLogMaxCharsPerChunk: number;
  agentLogSyncLockTtlSeconds: number;
  agentLogSyncLockFile: string;
  localLlmApiBaseUrl: string;
  localLlmApiKey: string;
  localLlmModel: string;
  vibeDistillationPromptVersion: string;
  vibeDistillationBatchSize: number;
  vibeDistillationMaxInputChars: number;
  vibeDistillationMaxOutputTokens: number;
  vibeDistillationTimeoutMs: number;
  vibeDistillationLockTtlSeconds: number;
  vibeDistillationLockFile: string;
  distillationToolMaxRounds: number;
  distillationToolTimeoutMs: number;
  distillationToolResultMaxChars: number;
  distillationSearchResultCount: number;
  distillationMaxCandidates: number;
  distillationMinCandidateScore: number;
  distillationFailureRetryDelaySeconds: number;
  sourceDistillationPromptVersion: string;
  sourceDistillationBatchSize: number;
  sourceDistillationMaxInputChars: number;
  sourceDistillationMaxOutputTokens: number;
  sourceDistillationLockTtlSeconds: number;
  sourceDistillationLockFile: string;
  defaultTokenBudget: number;
  enableVectorSearch: boolean;
  doctorFreshnessThresholdMinutes: number;
  doctorDegradedRateThreshold: number;
};

export const config = {} as FlatConfig;

Object.defineProperties(config, {
  databaseUrl: {
    get: () => groupedConfig.database.url,
    set: (value: string) => {
      groupedConfig.database.url = value;
    },
    enumerable: true,
  },
  embeddingDimension: {
    get: () => groupedConfig.embedding.dimension,
    set: (value: number) => {
      groupedConfig.embedding.dimension = value;
    },
    enumerable: true,
  },
  embeddingProvider: {
    get: () => groupedConfig.embedding.provider,
    set: (value: EmbeddingProvider) => {
      groupedConfig.embedding.provider = value;
    },
    enumerable: true,
  },
  embeddingDaemonUrl: {
    get: () => groupedConfig.embedding.daemonUrl,
    set: (value: string) => {
      groupedConfig.embedding.daemonUrl = value;
    },
    enumerable: true,
  },
  embeddingAccessToken: {
    get: () => groupedConfig.embedding.accessToken,
    set: (value: string) => {
      groupedConfig.embedding.accessToken = value;
    },
    enumerable: true,
  },
  embeddingTimeoutMs: {
    get: () => groupedConfig.embedding.timeoutMs,
    set: (value: number) => {
      groupedConfig.embedding.timeoutMs = value;
    },
    enumerable: true,
  },
  localLlmEmbeddingRoot: {
    get: () => groupedConfig.localLlm.embeddingRoot,
    set: (value: string) => {
      groupedConfig.localLlm.embeddingRoot = value;
    },
    enumerable: true,
  },
  localLlmEmbeddingPython: {
    get: () => groupedConfig.localLlm.embeddingPython,
    set: (value: string) => {
      groupedConfig.localLlm.embeddingPython = value;
    },
    enumerable: true,
  },
  localLlmEmbeddingModelDir: {
    get: () => groupedConfig.localLlm.embeddingModelDir,
    set: (value: string) => {
      groupedConfig.localLlm.embeddingModelDir = value;
    },
    enumerable: true,
  },
  sourceContentRoot: {
    get: () => groupedConfig.sourceContent.root,
    set: (value: string) => {
      groupedConfig.sourceContent.root = value;
    },
    enumerable: true,
  },
  codexSessionDir: {
    get: () => groupedConfig.codex.sessionDir,
    set: (value: string) => {
      groupedConfig.codex.sessionDir = value;
    },
    enumerable: true,
  },
  codexArchivedSessionDir: {
    get: () => groupedConfig.codex.archivedSessionDir,
    set: (value: string) => {
      groupedConfig.codex.archivedSessionDir = value;
    },
    enumerable: true,
  },
  antigravityLogDir: {
    get: () => groupedConfig.antigravity.logDir,
    set: (value: string) => {
      groupedConfig.antigravity.logDir = value;
    },
    enumerable: true,
  },
  agentLogSyncIntervalSeconds: {
    get: () => groupedConfig.agentLogSync.intervalSeconds,
    set: (value: number) => {
      groupedConfig.agentLogSync.intervalSeconds = value;
    },
    enumerable: true,
  },
  agentLogInitialLookbackHours: {
    get: () => groupedConfig.agentLogSync.initialLookbackHours,
    set: (value: number) => {
      groupedConfig.agentLogSync.initialLookbackHours = value;
    },
    enumerable: true,
  },
  antigravityLogInitialLookbackHours: {
    get: () => groupedConfig.antigravity.initialLookbackHours,
    set: (value: number) => {
      groupedConfig.antigravity.initialLookbackHours = value;
    },
    enumerable: true,
  },
  agentLogMaxMessagesPerChunk: {
    get: () => groupedConfig.agentLogSync.maxMessagesPerChunk,
    set: (value: number) => {
      groupedConfig.agentLogSync.maxMessagesPerChunk = value;
    },
    enumerable: true,
  },
  agentLogMaxCharsPerChunk: {
    get: () => groupedConfig.agentLogSync.maxCharsPerChunk,
    set: (value: number) => {
      groupedConfig.agentLogSync.maxCharsPerChunk = value;
    },
    enumerable: true,
  },
  agentLogSyncLockTtlSeconds: {
    get: () => groupedConfig.agentLogSync.lockTtlSeconds,
    set: (value: number) => {
      groupedConfig.agentLogSync.lockTtlSeconds = value;
    },
    enumerable: true,
  },
  agentLogSyncLockFile: {
    get: () => groupedConfig.agentLogSync.lockFile,
    set: (value: string) => {
      groupedConfig.agentLogSync.lockFile = value;
    },
    enumerable: true,
  },
  localLlmApiBaseUrl: {
    get: () => groupedConfig.localLlm.apiBaseUrl,
    set: (value: string) => {
      groupedConfig.localLlm.apiBaseUrl = value;
    },
    enumerable: true,
  },
  localLlmApiKey: {
    get: () => groupedConfig.localLlm.apiKey,
    set: (value: string) => {
      groupedConfig.localLlm.apiKey = value;
    },
    enumerable: true,
  },
  localLlmModel: {
    get: () => groupedConfig.localLlm.model,
    set: (value: string) => {
      groupedConfig.localLlm.model = value;
    },
    enumerable: true,
  },
  vibeDistillationPromptVersion: {
    get: () => groupedConfig.vibeDistillation.promptVersion,
    set: (value: string) => {
      groupedConfig.vibeDistillation.promptVersion = value;
    },
    enumerable: true,
  },
  vibeDistillationBatchSize: {
    get: () => groupedConfig.vibeDistillation.batchSize,
    set: (value: number) => {
      groupedConfig.vibeDistillation.batchSize = value;
    },
    enumerable: true,
  },
  vibeDistillationMaxInputChars: {
    get: () => groupedConfig.vibeDistillation.maxInputChars,
    set: (value: number) => {
      groupedConfig.vibeDistillation.maxInputChars = value;
    },
    enumerable: true,
  },
  vibeDistillationMaxOutputTokens: {
    get: () => groupedConfig.vibeDistillation.maxOutputTokens,
    set: (value: number) => {
      groupedConfig.vibeDistillation.maxOutputTokens = value;
    },
    enumerable: true,
  },
  vibeDistillationTimeoutMs: {
    get: () => groupedConfig.vibeDistillation.timeoutMs,
    set: (value: number) => {
      groupedConfig.vibeDistillation.timeoutMs = value;
    },
    enumerable: true,
  },
  vibeDistillationLockTtlSeconds: {
    get: () => groupedConfig.vibeDistillation.lockTtlSeconds,
    set: (value: number) => {
      groupedConfig.vibeDistillation.lockTtlSeconds = value;
    },
    enumerable: true,
  },
  vibeDistillationLockFile: {
    get: () => groupedConfig.vibeDistillation.lockFile,
    set: (value: string) => {
      groupedConfig.vibeDistillation.lockFile = value;
    },
    enumerable: true,
  },
  distillationToolMaxRounds: {
    get: () => groupedConfig.distillationTools.maxRounds,
    set: (value: number) => {
      groupedConfig.distillationTools.maxRounds = value;
    },
    enumerable: true,
  },
  distillationToolTimeoutMs: {
    get: () => groupedConfig.distillationTools.timeoutMs,
    set: (value: number) => {
      groupedConfig.distillationTools.timeoutMs = value;
    },
    enumerable: true,
  },
  distillationToolResultMaxChars: {
    get: () => groupedConfig.distillationTools.resultMaxChars,
    set: (value: number) => {
      groupedConfig.distillationTools.resultMaxChars = value;
    },
    enumerable: true,
  },
  distillationSearchResultCount: {
    get: () => groupedConfig.distillationTools.searchResultCount,
    set: (value: number) => {
      groupedConfig.distillationTools.searchResultCount = value;
    },
    enumerable: true,
  },
  distillationMaxCandidates: {
    get: () => groupedConfig.distillationTools.maxCandidates,
    set: (value: number) => {
      groupedConfig.distillationTools.maxCandidates = value;
    },
    enumerable: true,
  },
  distillationMinCandidateScore: {
    get: () => groupedConfig.distillationTools.minCandidateScore,
    set: (value: number) => {
      groupedConfig.distillationTools.minCandidateScore = value;
    },
    enumerable: true,
  },
  distillationFailureRetryDelaySeconds: {
    get: () => groupedConfig.distillationTools.failureRetryDelaySeconds,
    set: (value: number) => {
      groupedConfig.distillationTools.failureRetryDelaySeconds = value;
    },
    enumerable: true,
  },
  sourceDistillationPromptVersion: {
    get: () => groupedConfig.sourceDistillation.promptVersion,
    set: (value: string) => {
      groupedConfig.sourceDistillation.promptVersion = value;
    },
    enumerable: true,
  },
  sourceDistillationBatchSize: {
    get: () => groupedConfig.sourceDistillation.batchSize,
    set: (value: number) => {
      groupedConfig.sourceDistillation.batchSize = value;
    },
    enumerable: true,
  },
  sourceDistillationMaxInputChars: {
    get: () => groupedConfig.sourceDistillation.maxInputChars,
    set: (value: number) => {
      groupedConfig.sourceDistillation.maxInputChars = value;
    },
    enumerable: true,
  },
  sourceDistillationMaxOutputTokens: {
    get: () => groupedConfig.sourceDistillation.maxOutputTokens,
    set: (value: number) => {
      groupedConfig.sourceDistillation.maxOutputTokens = value;
    },
    enumerable: true,
  },
  sourceDistillationLockTtlSeconds: {
    get: () => groupedConfig.sourceDistillation.lockTtlSeconds,
    set: (value: number) => {
      groupedConfig.sourceDistillation.lockTtlSeconds = value;
    },
    enumerable: true,
  },
  sourceDistillationLockFile: {
    get: () => groupedConfig.sourceDistillation.lockFile,
    set: (value: string) => {
      groupedConfig.sourceDistillation.lockFile = value;
    },
    enumerable: true,
  },
  defaultTokenBudget: {
    get: () => groupedConfig.compile.defaultTokenBudget,
    set: (value: number) => {
      groupedConfig.compile.defaultTokenBudget = value;
    },
    enumerable: true,
  },
  enableVectorSearch: {
    get: () => groupedConfig.compile.enableVectorSearch,
    set: (value: boolean) => {
      groupedConfig.compile.enableVectorSearch = value;
    },
    enumerable: true,
  },
  doctorFreshnessThresholdMinutes: {
    get: () => groupedConfig.doctor.freshnessThresholdMinutes,
    set: (value: number) => {
      groupedConfig.doctor.freshnessThresholdMinutes = value;
    },
    enumerable: true,
  },
  doctorDegradedRateThreshold: {
    get: () => groupedConfig.doctor.degradedRateThreshold,
    set: (value: number) => {
      groupedConfig.doctor.degradedRateThreshold = value;
    },
    enumerable: true,
  },
});
