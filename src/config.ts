import { config as loadEnv } from "dotenv";

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
