import { groupedConfig } from "../../config.js";
import type { DistillationProviderSetting } from "../distillation/distillation-runtime.service.js";
import { runCoverEvidenceForCandidate } from "../coverEvidence/runner.js";
import { runFinalizeDistille, type FinalizeDistilleResult } from "../finalizeDistille/domain.js";
import { runFindCandidate } from "../findCandidate/domain.js";
import type { DistillationTargetKind } from "../selectDistillationTarget/domain.js";
import { refreshDistillationTargetInventory } from "../selectDistillationTarget/inventory.service.js";
import {
  claimNextDistillationTargetState,
  DEFAULT_DISTILLATION_TARGET_VERSION,
  finishDistillationTargetState,
  pauseDistillationTargetState,
  recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets,
  updateDistillationTargetHeartbeat,
  updateDistillationTargetPhase,
  type DistillationTargetStateRow,
} from "../selectDistillationTarget/repository.js";

export type DistillationPipelineInput = {
  kind?: "auto" | "wiki" | "vibe";
  limit?: number;
  worker?: string;
  provider?: DistillationProviderSetting;
  distillationVersion?: string;
  refresh?: boolean;
  rootPath?: string;
  vibeLimit?: number;
  forceRefreshEvidence?: boolean;
  write: true;
};

export type DistillationPipelineTargetResult = {
  targetStateId: string;
  targetKind: string;
  targetKey: string;
  status: "completed" | "skipped" | "paused" | "failed";
  outcomeKind: string;
  candidateCount: number;
  knowledgeIds: string[];
  coverEvidence: Array<{
    coverEvidenceResultId: string;
    findCandidateId: string;
    status: string;
    retryable: boolean;
    reason: string | null;
  }>;
  finalize: FinalizeDistilleResult[];
  error?: string;
};

export type DistillationPipelineResult = {
  distillationVersion: string;
  processed: number;
  idle: boolean;
  results: DistillationPipelineTargetResult[];
};

type CoverResult = Awaited<ReturnType<typeof runCoverEvidenceForCandidate>>;

function targetKindFilter(
  kind: DistillationPipelineInput["kind"],
): DistillationTargetKind | undefined {
  if (kind === "wiki") return "wiki_file";
  if (kind === "vibe") return "vibe_memory";
  return undefined;
}

function positiveLimit(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? 1));
}

function coverStatusCounts(results: CoverResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}

function embeddingStatusCounts(results: FinalizeDistilleResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.embeddingStatus] = (counts[result.embeddingStatus] ?? 0) + 1;
  }
  return counts;
}

function compactCoverResults(
  results: CoverResult[],
): DistillationPipelineTargetResult["coverEvidence"] {
  return results.map((result) => ({
    coverEvidenceResultId: result.coverEvidenceResultId,
    findCandidateId: result.findCandidateId,
    status: result.status,
    retryable: result.retryable,
    reason: result.reason,
  }));
}

async function finishSkipped(params: {
  target: DistillationTargetStateRow;
  outcomeKind: string;
  candidateCount: number;
  coverResults: CoverResult[];
}): Promise<DistillationPipelineTargetResult> {
  await finishDistillationTargetState({
    id: params.target.id,
    status: "skipped",
    outcomeKind: params.outcomeKind,
    candidateCount: params.candidateCount,
    knowledgeIds: [],
    metadata: {
      coverEvidenceStatusCounts: coverStatusCounts(params.coverResults),
    },
  });
  return {
    targetStateId: params.target.id,
    targetKind: params.target.targetKind,
    targetKey: params.target.targetKey,
    status: "skipped",
    outcomeKind: params.outcomeKind,
    candidateCount: params.candidateCount,
    knowledgeIds: [],
    coverEvidence: compactCoverResults(params.coverResults),
    finalize: [],
  };
}

async function runClaimedTarget(
  target: DistillationTargetStateRow,
  input: DistillationPipelineInput,
): Promise<DistillationPipelineTargetResult> {
  try {
    await updateDistillationTargetPhase({ id: target.id, phase: "finding_candidate" });
    await updateDistillationTargetHeartbeat(target.id);
    const findResult = await runFindCandidate({
      targetStateId: target.id,
      provider: input.provider,
      callerMode: "storage",
    });
    const candidateIds = findResult.insertedIds ?? [];
    const candidateCount = findResult.candidates.length;
    if (candidateIds.length === 0) {
      return finishSkipped({
        target,
        outcomeKind: "no_candidate",
        candidateCount,
        coverResults: [],
      });
    }

    await updateDistillationTargetPhase({ id: target.id, phase: "covering_evidence" });
    await updateDistillationTargetHeartbeat(target.id);
    const coverResults: CoverResult[] = [];
    for (const findCandidateId of candidateIds) {
      coverResults.push(
        await runCoverEvidenceForCandidate({
          targetStateId: target.id,
          findCandidateId,
          provider: input.provider,
          forceRefreshEvidence: input.forceRefreshEvidence,
        }),
      );
      await updateDistillationTargetHeartbeat(target.id);
    }

    const ready = coverResults.filter((result) => result.status === "knowledge_ready");
    const retryable = coverResults.filter((result) => result.retryable);
    if (ready.length === 0 && retryable.length > 0) {
      await pauseDistillationTargetState({
        id: target.id,
        reason: "cover_evidence_retryable",
        retryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
        metadata: {
          coverEvidenceStatusCounts: coverStatusCounts(coverResults),
          retryableCoverEvidenceIds: retryable.map((result) => result.coverEvidenceResultId),
        },
      });
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: "paused",
        outcomeKind: "cover_evidence_retryable",
        candidateCount,
        knowledgeIds: [],
        coverEvidence: compactCoverResults(coverResults),
        finalize: [],
      };
    }
    if (ready.length === 0) {
      return finishSkipped({
        target,
        outcomeKind: "all_rejected",
        candidateCount,
        coverResults,
      });
    }

    await updateDistillationTargetPhase({ id: target.id, phase: "finalizing" });
    await updateDistillationTargetHeartbeat(target.id);
    const finalizeResults: FinalizeDistilleResult[] = [];
    const finalizeErrors: Array<{ coverEvidenceResultId: string; error: string }> = [];
    for (const result of ready) {
      try {
        finalizeResults.push(
          await runFinalizeDistille({
            coverEvidenceResultId: result.coverEvidenceResultId,
            write: true,
          }),
        );
      } catch (error) {
        finalizeErrors.push({
          coverEvidenceResultId: result.coverEvidenceResultId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await updateDistillationTargetHeartbeat(target.id);
    }

    const stored = finalizeResults.filter(
      (result) => result.status === "stored" && result.knowledgeId,
    );
    const knowledgeIds = stored
      .map((result) => result.knowledgeId)
      .filter((id): id is string => Boolean(id));
    if (knowledgeIds.length === 0) {
      await finishDistillationTargetState({
        id: target.id,
        status: "failed",
        outcomeKind: "finalize_failed",
        error:
          finalizeErrors.map((entry) => entry.error).join(" | ") ||
          "finalize produced no knowledge",
        candidateCount,
        knowledgeIds: [],
        metadata: {
          coverEvidenceStatusCounts: coverStatusCounts(coverResults),
          finalizeErrors,
        },
      });
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: "failed",
        outcomeKind: "finalize_failed",
        candidateCount,
        knowledgeIds: [],
        coverEvidence: compactCoverResults(coverResults),
        finalize: finalizeResults,
        error: finalizeErrors.map((entry) => entry.error).join(" | ") || undefined,
      };
    }

    const outcomeKind =
      retryable.length > 0
        ? "knowledge_finalized_with_retryable_rejections"
        : "knowledge_finalized";
    await finishDistillationTargetState({
      id: target.id,
      status: "completed",
      outcomeKind,
      candidateCount,
      knowledgeIds,
      metadata: {
        coverEvidenceStatusCounts: coverStatusCounts(coverResults),
        embeddingStatusCounts: embeddingStatusCounts(finalizeResults),
        retryableCoverEvidenceIds: retryable.map((result) => result.coverEvidenceResultId),
        finalizeErrors,
      },
    });
    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      status: "completed",
      outcomeKind,
      candidateCount,
      knowledgeIds,
      coverEvidence: compactCoverResults(coverResults),
      finalize: finalizeResults,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pauseDistillationTargetState({
      id: target.id,
      reason: message,
      retryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
      metadata: {
        pipelineError: message,
      },
    });
    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      status: "paused",
      outcomeKind: "pipeline_paused",
      candidateCount: 0,
      knowledgeIds: [],
      coverEvidence: [],
      finalize: [],
      error: message,
    };
  }
}

export async function runDistillationPipeline(
  input: DistillationPipelineInput,
): Promise<DistillationPipelineResult> {
  if (!input.write) {
    throw new Error("distillation pipeline requires write=true");
  }
  const distillationVersion = input.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  if (input.refresh ?? true) {
    await refreshDistillationTargetInventory({
      kind: input.kind ?? "auto",
      rootPath: input.rootPath,
      vibeLimit: input.vibeLimit,
      distillationVersion,
    });
  }
  await recoverStaleDistillationTargets({ distillationVersion });
  await releaseRetryablePausedDistillationTargets({ distillationVersion });

  const results: DistillationPipelineTargetResult[] = [];
  for (let index = 0; index < positiveLimit(input.limit); index += 1) {
    const target = await claimNextDistillationTargetState({
      distillationVersion,
      targetKind: targetKindFilter(input.kind),
      worker: input.worker,
    });
    if (!target) break;
    results.push(await runClaimedTarget(target, input));
  }

  return {
    distillationVersion,
    processed: results.length,
    idle: results.length === 0,
    results,
  };
}
