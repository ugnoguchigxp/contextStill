import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { APP_CONSTANTS } from "./constants.js";

loadEnv({ quiet: true });

const envBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const envNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

type EmbeddingProvider = "auto" | "daemon" | "cli" | "disabled";
type AgenticCompileProvider = "azure-openai" | "bedrock" | "local-llm" | "auto";
type DistillationProvider = "local-llm" | "azure-openai" | "bedrock" | "auto";

const parseAgenticCompileProvider = (
  value: string | undefined,
  fallback: AgenticCompileProvider,
): AgenticCompileProvider => {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "azure-openai" ||
    normalized === "bedrock" ||
    normalized === "local-llm" ||
    normalized === "auto"
  ) {
    return normalized;
  }
  return fallback;
};

const parseDistillationProvider = (
  value: string | undefined,
  fallback: DistillationProvider,
): DistillationProvider => {
  if (value === undefined || value.trim() === "") return fallback;
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
  azureOpenAi: {
    apiKey: string;
    apiBaseUrl: string;
    apiPath: string;
    apiVersion: string;
    model: string;
  };
  bedrock: {
    model: string;
    region: string;
    profile: string;
  };
  agenticCompile: {
    provider: AgenticCompileProvider;
    enabled: boolean;
    timeoutMs: number;
    maxTokens: number;
  };
  distillation: {
    provider: DistillationProvider;
  };
  doctor: { freshnessThresholdMinutes: number; degradedRateThreshold: number };
};

export const groupedConfig: GroupedConfig = {
  database: {
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:7889/memory_router",
  },
  embedding: {
    dimension: Math.max(
      1,
      envNumber(process.env.MEMORY_ROUTER_EMBEDDING_DIMENSION, APP_CONSTANTS.embeddingDimension),
    ),
    provider: (process.env.MEMORY_ROUTER_EMBEDDING_PROVIDER || "auto").trim() as EmbeddingProvider,
    daemonUrl: (process.env.MEMORY_ROUTER_EMBEDDING_DAEMON_URL || "http://127.0.0.1:44512").replace(
      /\/+$/,
      "",
    ),
    accessToken:
      process.env.MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    timeoutMs: Math.max(
      500,
      envNumber(process.env.MEMORY_ROUTER_EMBEDDING_TIMEOUT_MS, APP_CONSTANTS.embeddingTimeoutMs),
    ),
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
        envNumber(
          process.env.MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS,
          APP_CONSTANTS.antigravityLogInitialLookbackHours,
        ),
      ),
    ),
  },
  agentLogSync: {
    intervalSeconds: Math.max(
      60,
      envNumber(
        process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS,
        APP_CONSTANTS.agentLogSyncIntervalSeconds,
      ),
    ),
    initialLookbackHours: Math.max(
      0,
      envNumber(
        process.env.MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS,
        APP_CONSTANTS.agentLogInitialLookbackHours,
      ),
    ),
    maxMessagesPerChunk: Math.max(
      1,
      envNumber(
        process.env.MEMORY_ROUTER_AGENT_LOG_MAX_MESSAGES_PER_CHUNK,
        APP_CONSTANTS.agentLogMaxMessagesPerChunk,
      ),
    ),
    maxCharsPerChunk: Math.max(
      512,
      envNumber(
        process.env.MEMORY_ROUTER_AGENT_LOG_MAX_CHARS_PER_CHUNK,
        APP_CONSTANTS.agentLogMaxCharsPerChunk,
      ),
    ),
    lockTtlSeconds: Math.max(
      60,
      envNumber(
        process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_TTL_SECONDS,
        APP_CONSTANTS.agentLogSyncLockTtlSeconds,
      ),
    ),
    lockFile:
      process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_FILE ||
      path.resolve(process.cwd(), "logs", "agent-log-sync.lock"),
  },
  vibeDistillation: {
    promptVersion:
      process.env.MEMORY_ROUTER_VIBE_DISTILLATION_PROMPT_VERSION ||
      APP_CONSTANTS.vibeDistillationPromptVersion,
    batchSize: Math.max(
      1,
      envNumber(
        process.env.MEMORY_ROUTER_VIBE_DISTILLATION_BATCH_SIZE,
        APP_CONSTANTS.vibeDistillationBatchSize,
      ),
    ),
    maxInputChars: Math.max(
      2048,
      envNumber(
        process.env.MEMORY_ROUTER_VIBE_DISTILLATION_MAX_INPUT_CHARS,
        APP_CONSTANTS.vibeDistillationMaxInputChars,
      ),
    ),
    maxOutputTokens: Math.max(
      128,
      envNumber(
        process.env.MEMORY_ROUTER_VIBE_DISTILLATION_MAX_OUTPUT_TOKENS,
        APP_CONSTANTS.vibeDistillationMaxOutputTokens,
      ),
    ),
    timeoutMs: Math.max(
      1000,
      envNumber(
        process.env.MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS,
        APP_CONSTANTS.vibeDistillationTimeoutMs,
      ),
    ),
    lockTtlSeconds: Math.max(
      60,
      envNumber(
        process.env.MEMORY_ROUTER_VIBE_DISTILLATION_LOCK_TTL_SECONDS,
        APP_CONSTANTS.vibeDistillationLockTtlSeconds,
      ),
    ),
    lockFile:
      process.env.MEMORY_ROUTER_VIBE_DISTILLATION_LOCK_FILE ||
      path.resolve(process.cwd(), "logs", "vibe-distillation.lock"),
  },
  sourceDistillation: {
    promptVersion:
      process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_PROMPT_VERSION ||
      APP_CONSTANTS.sourceDistillationPromptVersion,
    batchSize: Math.max(
      1,
      envNumber(
        process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_BATCH_SIZE,
        APP_CONSTANTS.sourceDistillationBatchSize,
      ),
    ),
    maxInputChars: Math.max(
      2048,
      envNumber(
        process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_INPUT_CHARS,
        APP_CONSTANTS.sourceDistillationMaxInputChars,
      ),
    ),
    maxOutputTokens: Math.max(
      128,
      envNumber(
        process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_OUTPUT_TOKENS,
        APP_CONSTANTS.sourceDistillationMaxOutputTokens,
      ),
    ),
    lockTtlSeconds: Math.max(
      60,
      envNumber(
        process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_LOCK_TTL_SECONDS,
        APP_CONSTANTS.sourceDistillationLockTtlSeconds,
      ),
    ),
    lockFile:
      process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_LOCK_FILE ||
      path.resolve(process.cwd(), "logs", "source-distillation.lock"),
  },
  distillationTools: {
    maxRounds: Math.max(
      0,
      envNumber(
        process.env.MEMORY_ROUTER_DISTILLATION_TOOL_MAX_ROUNDS,
        APP_CONSTANTS.distillationToolMaxRounds,
      ),
    ),
    timeoutMs: Math.max(
      1000,
      envNumber(
        process.env.MEMORY_ROUTER_DISTILLATION_TOOL_TIMEOUT_MS,
        APP_CONSTANTS.distillationToolTimeoutMs,
      ),
    ),
    resultMaxChars: Math.max(
      512,
      envNumber(
        process.env.MEMORY_ROUTER_DISTILLATION_TOOL_RESULT_MAX_CHARS,
        APP_CONSTANTS.distillationToolResultMaxChars,
      ),
    ),
    searchResultCount: Math.max(
      1,
      envNumber(
        process.env.MEMORY_ROUTER_DISTILLATION_SEARCH_RESULT_COUNT,
        APP_CONSTANTS.distillationSearchResultCount,
      ),
    ),
    maxCandidates: Math.max(
      1,
      envNumber(
        process.env.MEMORY_ROUTER_DISTILLATION_MAX_CANDIDATES,
        APP_CONSTANTS.distillationMaxCandidates,
      ),
    ),
    minCandidateScore: Math.min(
      1,
      Math.max(
        0,
        envNumber(
          process.env.MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE,
          APP_CONSTANTS.distillationMinCandidateScore,
        ),
      ),
    ),
    failureRetryDelaySeconds: Math.max(
      0,
      envNumber(
        process.env.MEMORY_ROUTER_DISTILLATION_FAILURE_RETRY_DELAY_SECONDS,
        APP_CONSTANTS.distillationFailureRetryDelaySeconds,
      ),
    ),
  },
  compile: {
    defaultTokenBudget: Math.max(
      256,
      envNumber(process.env.MEMORY_ROUTER_DEFAULT_TOKEN_BUDGET, APP_CONSTANTS.defaultTokenBudget),
    ),
    enableVectorSearch: envBoolean(
      process.env.MEMORY_ROUTER_ENABLE_VECTOR_SEARCH,
      APP_CONSTANTS.enableVectorSearch,
    ),
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
      process.env.GNOSIS_REVIEW_LLM_API_BASE_URL ||
      ""
    ).replace(/\/+$/, ""),
    apiPath: process.env.MEMORY_ROUTER_AZURE_OPENAI_API_PATH || "/openai/deployments",
    apiVersion:
      process.env.MEMORY_ROUTER_AZURE_OPENAI_API_VERSION ||
      process.env.AZURE_OPENAI_API_VERSION ||
      process.env.GNOSIS_REVIEW_LLM_API_VERSION ||
      "2025-04-01-preview",
    model:
      process.env.MEMORY_ROUTER_AZURE_OPENAI_MODEL ||
      process.env.AZURE_OPENAI_MODEL ||
      process.env.OPENAI_API_MODEL ||
      "gpt-4o",
  },
  bedrock: {
    model: process.env.MEMORY_ROUTER_BEDROCK_MODEL || "",
    region: process.env.MEMORY_ROUTER_BEDROCK_REGION || process.env.AWS_REGION || "us-east-1",
    profile: process.env.MEMORY_ROUTER_BEDROCK_PROFILE || process.env.AWS_PROFILE || "",
  },
  agenticCompile: {
    provider: parseAgenticCompileProvider(
      process.env.MEMORY_ROUTER_CONTEXT_COMPILE_AGENTIC_PROVIDER,
      "azure-openai",
    ),
    enabled: envBoolean(
      process.env.MEMORY_ROUTER_CONTEXT_COMPILE_AGENTIC_ENABLED,
      APP_CONSTANTS.agenticCompileEnabled,
    ),
    timeoutMs: Math.max(
      1000,
      envNumber(
        process.env.MEMORY_ROUTER_CONTEXT_COMPILE_AGENTIC_TIMEOUT_MS,
        APP_CONSTANTS.agenticCompileTimeoutMs,
      ),
    ),
    maxTokens: Math.max(
      256,
      envNumber(
        process.env.MEMORY_ROUTER_CONTEXT_COMPILE_AGENTIC_MAX_TOKENS,
        APP_CONSTANTS.agenticCompileMaxTokens,
      ),
    ),
  },
  distillation: {
    provider: parseDistillationProvider(
      process.env.MEMORY_ROUTER_DISTILLATION_PROVIDER,
      "local-llm",
    ),
  },
  doctor: {
    freshnessThresholdMinutes: Math.max(
      1,
      envNumber(
        process.env.MEMORY_ROUTER_DOCTOR_FRESHNESS_THRESHOLD_MINUTES,
        APP_CONSTANTS.doctorFreshnessThresholdMinutes,
      ),
    ),
    degradedRateThreshold: Math.min(
      1,
      Math.max(
        0,
        envNumber(
          process.env.MEMORY_ROUTER_DOCTOR_DEGRADED_RATE_THRESHOLD,
          APP_CONSTANTS.doctorDegradedRateThreshold,
        ),
      ),
    ),
  },
};

export type { GroupedConfig, EmbeddingProvider, AgenticCompileProvider, DistillationProvider };
