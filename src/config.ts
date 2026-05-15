import { config as loadEnv } from "dotenv";
import os from "node:os";
import path from "node:path";

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

export const config = {
  databaseUrl:
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:7889/memory_router",
  embeddingDimension: Math.max(1, envNumber(process.env.MEMORY_ROUTER_EMBEDDING_DIMENSION, 384)),
  embeddingProvider: (process.env.MEMORY_ROUTER_EMBEDDING_PROVIDER || "auto").trim() as
    | "auto"
    | "daemon"
    | "cli"
    | "disabled",
  embeddingDaemonUrl: (
    process.env.MEMORY_ROUTER_EMBEDDING_DAEMON_URL || "http://127.0.0.1:44512"
  ).replace(/\/+$/, ""),
  embeddingAccessToken:
    process.env.MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
  embeddingTimeoutMs: Math.max(
    500,
    envNumber(process.env.MEMORY_ROUTER_EMBEDDING_TIMEOUT_MS, 10_000),
  ),
  localLlmEmbeddingRoot:
    process.env.MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_ROOT ||
    path.resolve(process.cwd(), "../local-llm/embedding"),
  localLlmEmbeddingPython:
    process.env.MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_PYTHON ||
    path.resolve(process.cwd(), "../local-llm/embedding/.venv/bin/python"),
  localLlmEmbeddingModelDir:
    process.env.MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_MODEL_DIR ||
    path.resolve(process.cwd(), "../local-llm/embedding/models/multilingual-e5-small"),
  sourceContentRoot:
    process.env.MEMORY_ROUTER_SOURCE_CONTENT_ROOT || path.resolve(process.cwd(), "wiki"),
  codexSessionDir:
    process.env.MEMORY_ROUTER_CODEX_SESSION_DIR || path.join(os.homedir(), ".codex", "sessions"),
  codexArchivedSessionDir:
    process.env.MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIR ||
    path.join(os.homedir(), ".codex", "archived_sessions"),
  antigravityLogDir:
    process.env.MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR ||
    path.join(os.homedir(), ".gemini", "antigravity", "brain"),
  agentLogSyncIntervalSeconds: Math.max(
    60,
    envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS, 3600),
  ),
  agentLogInitialLookbackHours: Math.max(
    0,
    envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS, 168),
  ),
  antigravityLogInitialLookbackHours: Math.max(
    0,
    envNumber(
      process.env.MEMORY_ROUTER_ANTIGRAVITY_LOG_INITIAL_LOOKBACK_HOURS,
      envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS, 24),
    ),
  ),
  agentLogMaxMessagesPerChunk: Math.max(
    1,
    envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_MAX_MESSAGES_PER_CHUNK, 120),
  ),
  agentLogMaxCharsPerChunk: Math.max(
    512,
    envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_MAX_CHARS_PER_CHUNK, 12000),
  ),
  agentLogSyncLockTtlSeconds: Math.max(
    60,
    envNumber(process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_TTL_SECONDS, 1800),
  ),
  agentLogSyncLockFile:
    process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_FILE ||
    path.resolve(process.cwd(), "logs", "agent-log-sync.lock"),
  localLlmApiBaseUrl: (
    process.env.MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL || "http://127.0.0.1:44448"
  ).replace(/\/+$/, ""),
  localLlmApiKey:
    process.env.MEMORY_ROUTER_LOCAL_LLM_API_KEY || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
  localLlmModel: process.env.MEMORY_ROUTER_LOCAL_LLM_MODEL || "gemma-4-e4b-it",
  vibeDistillationPromptVersion:
    process.env.MEMORY_ROUTER_VIBE_DISTILLATION_PROMPT_VERSION || "vibe-memory-rule-procedure-v1",
  vibeDistillationBatchSize: Math.max(
    1,
    envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_BATCH_SIZE, 10),
  ),
  vibeDistillationMaxInputChars: Math.max(
    2048,
    envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_MAX_INPUT_CHARS, 12000),
  ),
  vibeDistillationMaxOutputTokens: Math.max(
    128,
    envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_MAX_OUTPUT_TOKENS, 2048),
  ),
  vibeDistillationTimeoutMs: Math.max(
    1000,
    envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS, 120_000),
  ),
  vibeDistillationLockTtlSeconds: Math.max(
    60,
    envNumber(process.env.MEMORY_ROUTER_VIBE_DISTILLATION_LOCK_TTL_SECONDS, 1800),
  ),
  vibeDistillationLockFile:
    process.env.MEMORY_ROUTER_VIBE_DISTILLATION_LOCK_FILE ||
    path.resolve(process.cwd(), "logs", "vibe-distillation.lock"),
  distillationToolMaxRounds: Math.max(
    0,
    envNumber(process.env.MEMORY_ROUTER_DISTILLATION_TOOL_MAX_ROUNDS, 4),
  ),
  distillationToolTimeoutMs: Math.max(
    1000,
    envNumber(process.env.MEMORY_ROUTER_DISTILLATION_TOOL_TIMEOUT_MS, 10_000),
  ),
  distillationToolResultMaxChars: Math.max(
    1000,
    envNumber(process.env.MEMORY_ROUTER_DISTILLATION_TOOL_RESULT_MAX_CHARS, 6000),
  ),
  distillationSearchResultCount: Math.max(
    1,
    envNumber(process.env.MEMORY_ROUTER_DISTILLATION_SEARCH_RESULT_COUNT, 3),
  ),
  distillationMaxCandidates: Math.max(
    1,
    envNumber(process.env.MEMORY_ROUTER_DISTILLATION_MAX_CANDIDATES, 2),
  ),
  distillationMinCandidateScore: Math.min(
    1,
    Math.max(0, envNumber(process.env.MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE, 0.75)),
  ),
  distillationFailureRetryDelaySeconds: Math.max(
    60,
    envNumber(process.env.MEMORY_ROUTER_DISTILLATION_FAILURE_RETRY_DELAY_SECONDS, 21600),
  ),
  sourceDistillationPromptVersion:
    process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_PROMPT_VERSION || "source-wiki-rule-procedure-v1",
  sourceDistillationBatchSize: Math.max(
    1,
    envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_BATCH_SIZE, 10),
  ),
  sourceDistillationMaxInputChars: Math.max(
    2048,
    envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_INPUT_CHARS, 12000),
  ),
  sourceDistillationMaxOutputTokens: Math.max(
    128,
    envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_OUTPUT_TOKENS, 2048),
  ),
  sourceDistillationLockTtlSeconds: Math.max(
    60,
    envNumber(process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_LOCK_TTL_SECONDS, 1800),
  ),
  sourceDistillationLockFile:
    process.env.MEMORY_ROUTER_SOURCE_DISTILLATION_LOCK_FILE ||
    path.resolve(process.cwd(), "logs", "source-distillation.lock"),
  defaultTokenBudget: Math.max(
    256,
    envNumber(process.env.MEMORY_ROUTER_DEFAULT_TOKEN_BUDGET, 3000),
  ),
  enableVectorSearch: envBoolean(process.env.MEMORY_ROUTER_ENABLE_VECTOR_SEARCH, true),
  doctorFreshnessThresholdMinutes: Math.max(
    1,
    envNumber(process.env.MEMORY_ROUTER_DOCTOR_FRESHNESS_THRESHOLD_MINUTES, 720),
  ),
  doctorDegradedRateThreshold: Math.min(
    1,
    Math.max(0, envNumber(process.env.MEMORY_ROUTER_DOCTOR_DEGRADED_RATE_THRESHOLD, 0.5)),
  ),
};
