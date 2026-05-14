import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ quiet: true });

export const envBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const envNumber = (value: string | undefined, fallback: number): number => {
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
