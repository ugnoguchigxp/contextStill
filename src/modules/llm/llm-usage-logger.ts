import { randomUUID } from "node:crypto";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { llmUsageLogs } from "../../db/schema.js";
import { calculateCost } from "./llm-cost-config.js";
import type { LlmChatResponse } from "./llm-provider.js";
import { estimateLlmUsage } from "./token-estimator.js";
import { normalizeLlmUsage } from "./usage-normalizer.js";

export type LlmUsageLogInput = {
  provider: string;
  model: string;
  usage?: LlmChatResponse["usage"];
  promptMessages?: readonly unknown[];
  promptMetadata?: unknown;
  completionText?: string | null;
  completionMetadata?: unknown;
  source?: string;
};

type LlmUsageLogRow = typeof llmUsageLogs.$inferInsert;

/**
 * LLM usage を measured usage 優先で正規化し、usage がない provider では入出力から推定します。
 */
export function measureLlmUsage(params: LlmUsageLogInput): LlmUsageLogRow | null {
  const { provider, model, usage, source = "unknown" } = params;

  const measuredUsage = usage
    ? normalizeLlmUsage({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
      })
    : undefined;
  const estimatedUsage = estimateLlmUsage({
    promptMessages: params.promptMessages,
    promptMetadata: params.promptMetadata,
    completionText: params.completionText,
    completionMetadata: params.completionMetadata,
  });
  const resolvedUsage = measuredUsage ?? estimatedUsage;
  const usageMode = measuredUsage ? "measured" : "estimated";

  if (!resolvedUsage) {
    return null;
  }

  const promptTokens = resolvedUsage.promptTokens;
  const completionTokens = resolvedUsage.completionTokens;
  const totalTokens = resolvedUsage.totalTokens;
  const reasoningTokens = resolvedUsage.reasoningTokens ?? 0;

  // JPYコスト計算
  let costJpy = calculateCost(model, promptTokens, completionTokens);
  let resolvedUsageMode = usageMode;
  if (provider === "codex") {
    costJpy = 0;
    resolvedUsageMode = "unknown";
  }

  return {
    provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    costJpy,
    usageMode: resolvedUsageMode,
    source,
  };
}

async function insertLlmUsageLog(row: LlmUsageLogRow): Promise<void> {
  try {
    if (resolveDatabaseBackendConfig().kind === "sqlite") {
      const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
      const sqlite = await getRuntimeSqliteCoreDatabase();
      sqlite.db
        .query(
          `INSERT INTO llm_usage_logs (
            id,
            provider,
            model,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            reasoning_tokens,
            cost_jpy,
            usage_mode,
            source,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id ?? randomUUID(),
          row.provider,
          row.model,
          row.promptTokens,
          row.completionTokens,
          row.totalTokens,
          row.reasoningTokens ?? 0,
          row.costJpy ?? 0,
          row.usageMode ?? "estimated",
          row.source ?? "unknown",
          new Date().toISOString(),
        );
      return;
    }
    await db.insert(llmUsageLogs).values(row);
  } catch (error) {
    console.error("[LlmUsageLogger] Failed to write usage log to DB:", error);
  }
}

export async function logLlmUsage(params: LlmUsageLogInput): Promise<void> {
  const row = measureLlmUsage(params);
  if (!row) return;
  await insertLlmUsageLog(row);
}

/**
 * LLM応答後に呼ぶ fire-and-forget 計測口。呼び出し元のタスク完了をDB保存で待たせません。
 */
export function recordLlmUsage(params: LlmUsageLogInput): void {
  const row = measureLlmUsage(params);
  if (!row) return;
  void insertLlmUsageLog(row);
}
