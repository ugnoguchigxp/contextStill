import { count, eq } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import { checkDistillationLlmHealth } from "../llm/agentic-llm.service.js";
import type { DistillationCandidateSourceRef } from "./distillation-candidate.repository.js";
import {
  claimDistillationJob,
  pauseDistillationJob,
  upsertDistillationJob,
  type DistillationJobRow,
} from "./distillation-job.repository.js";
import type { DistillationOutcomeKind } from "./distillation-outcomes.js";

export type DistillationCircuitBreakerState =
  | { allowed: true; health?: Awaited<ReturnType<typeof checkDistillationLlmHealth>> }
  | {
      allowed: false;
      reason: string;
      health?: Awaited<ReturnType<typeof checkDistillationLlmHealth>>;
    };

export async function checkDistillationCircuitBreaker(): Promise<DistillationCircuitBreakerState> {
  if (!groupedConfig.distillation.circuitBreakerEnabled) {
    return { allowed: true };
  }
  const health = await checkDistillationLlmHealth(
    groupedConfig.distillation.provider,
    groupedConfig.distillation.circuitBreakerHealthTimeoutMs,
  );
  if (health.configured && health.reachable) {
    return { allowed: true, health };
  }
  return {
    allowed: false,
    reason: health.error ?? "distillation LLM provider is not reachable",
    health,
  };
}

export async function beginDistillationJob(params: {
  apply: boolean;
  source: DistillationCandidateSourceRef;
  inputHash: string;
  promptVersion: string;
  metadata?: Record<string, unknown>;
}): Promise<DistillationJobRow | null> {
  if (!params.apply) return null;
  const job = await upsertDistillationJob({
    source: params.source,
    inputHash: params.inputHash,
    promptVersion: params.promptVersion,
    budget: {
      maxReads: groupedConfig.distillationTools.readerMaxReads,
      maxCandidates: groupedConfig.distillationTools.maxCandidates,
      maxToolRounds: groupedConfig.distillationTools.maxRounds,
    },
    metadata: params.metadata,
  });
  return claimDistillationJob(job.id);
}

export async function pauseJobForCircuitBreaker(params: {
  jobId?: string;
  reason: string;
  health?: Record<string, unknown>;
}): Promise<void> {
  await pauseDistillationJob({
    id: params.jobId,
    outcomeKind: "batch_paused_circuit_breaker",
    error: params.reason,
    pauseSeconds: groupedConfig.distillation.circuitBreakerPauseSeconds,
    metadata: {
      circuitBreaker: true,
      health: params.health,
    },
  });
}

export async function pauseJobForBackpressure(params: {
  jobId?: string;
  draftCount: number;
  threshold: number;
  acceptedCandidateCount: number;
}): Promise<void> {
  await pauseDistillationJob({
    id: params.jobId,
    outcomeKind: "promotion_paused_backpressure",
    error: "distillation promotion paused by HITL backlog",
    pauseSeconds: groupedConfig.distillation.backpressurePauseSeconds,
    metadata: {
      backpressure: true,
      draftCount: params.draftCount,
      backlogThresholdCount: params.threshold,
      acceptedCandidateCount: params.acceptedCandidateCount,
    },
  });
}

export async function shouldPauseDistillationPromotion(): Promise<{
  paused: boolean;
  draftCount: number;
  threshold: number;
  outcomeKind?: DistillationOutcomeKind;
}> {
  const threshold = groupedConfig.distillation.promotionBacklogThresholdCount;
  const [row] = await db
    .select({ value: count() })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.status, "draft"));
  const draftCount = Number(row?.value ?? 0);
  return {
    paused: draftCount > threshold,
    draftCount,
    threshold,
    outcomeKind: draftCount > threshold ? "promotion_paused_backpressure" : undefined,
  };
}
