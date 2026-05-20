import { groupedConfig } from "../../config.js";
import { APP_CONSTANTS } from "../../constants.js";
import {
  coverEvidenceResultFromRow,
  listCoverEvidenceResultsByTargetStateId,
  type CoverEvidenceResultRow,
} from "../coverEvidence/repository.js";
import type { DistillationProviderSetting } from "../distillation/distillation-runtime.service.js";
import { runCoverEvidenceForCandidate } from "../coverEvidence/runner.js";
import { runFinalizeDistille, type FinalizeDistilleResult } from "../finalizeDistille/domain.js";
import { runFindCandidate } from "../findCandidate/domain.js";
import {
  listFindCandidateResultsByTargetStateId,
  type FindCandidateResultRow,
} from "../findCandidate/repository.js";
import type { DistillationTargetKind } from "../selectDistillationTarget/domain.js";
import { refreshDistillationTargetInventory } from "../selectDistillationTarget/inventory.service.js";
import {
  claimNextDistillationTargetState,
  DEFAULT_DISTILLATION_TARGET_VERSION,
  finishDistillationTargetState,
  leaseFromTargetState,
  pauseDistillationTargetState,
  recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets,
  updateDistillationTargetHeartbeat,
  updateDistillationTargetPhase,
  type DistillationTargetStateRow,
  type TargetLease,
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

type CandidateSelection = {
  candidateIds: string[];
  candidateCount: number;
  reused: boolean;
};

const retryableCoverStatuses = new Set<string>(["tool_failed", "provider_failed", "parse_failed"]);

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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function targetTimeoutMessage(target: DistillationTargetStateRow): string {
  return `distillation target timed out after ${groupedConfig.distillation.targetTimeoutMs}ms: ${target.id}`;
}

function coverResultFromRow(row: CoverEvidenceResultRow): CoverResult {
  const result = coverEvidenceResultFromRow(row);
  return {
    coverEvidenceResultId: row.id,
    findCandidateId: row.id,
    status: result.status,
    stage: result.stage,
    retryable: retryableCoverStatuses.has(result.status),
    reason: result.reason,
  };
}

async function requireLease<T>(
  update: Promise<T | null>,
  target: DistillationTargetStateRow,
  action: string,
): Promise<T> {
  const row = await update;
  if (!row) {
    throw new Error(`distillation target lease lost during ${action}: ${target.id}`);
  }
  return row;
}

async function updatePhase(
  target: DistillationTargetStateRow,
  lease: TargetLease,
  phase: Parameters<typeof updateDistillationTargetPhase>[0]["phase"],
): Promise<void> {
  await requireLease(
    updateDistillationTargetPhase({ id: target.id, phase, lease }),
    target,
    `phase:${phase}`,
  );
}

async function heartbeat(target: DistillationTargetStateRow, lease: TargetLease): Promise<void> {
  await requireLease(updateDistillationTargetHeartbeat(target.id, lease), target, "heartbeat");
}

async function loadOrRunFindCandidate(
  target: DistillationTargetStateRow,
  lease: TargetLease,
  input: DistillationPipelineInput,
  signal: AbortSignal,
): Promise<CandidateSelection> {
  const existing = await listFindCandidateResultsByTargetStateId(target.id);
  if (existing.length > 0) {
    return {
      candidateIds: existing.map((row: FindCandidateResultRow) => row.id),
      candidateCount: existing.length,
      reused: true,
    };
  }

  await updatePhase(target, lease, "finding_candidate");
  await heartbeat(target, lease);
  const findResult = await runFindCandidate({
    targetStateId: target.id,
    provider: input.provider,
    callerMode: "storage",
    signal,
  });
  return {
    candidateIds: findResult.insertedIds ?? [],
    candidateCount: findResult.candidates.length,
    reused: false,
  };
}

async function runOrResumeCoverEvidence(
  target: DistillationTargetStateRow,
  lease: TargetLease,
  input: DistillationPipelineInput,
  signal: AbortSignal,
  candidateIds: string[],
): Promise<CoverResult[]> {
  await updatePhase(target, lease, "covering_evidence");
  await heartbeat(target, lease);

  const existingRows = await listCoverEvidenceResultsByTargetStateId(target.id);
  const existingByCandidateId = new Map(
    existingRows.map((row) => [row.id, coverResultFromRow(row)] as const),
  );
  const coverResults: CoverResult[] = [];

  for (const findCandidateId of candidateIds) {
    const existing = existingByCandidateId.get(findCandidateId);
    if (existing && !input.forceRefreshEvidence && !existing.retryable) {
      coverResults.push(existing);
      await heartbeat(target, lease);
      continue;
    }

    coverResults.push(
      await runCoverEvidenceForCandidate({
        targetStateId: target.id,
        findCandidateId,
        provider: input.provider,
        forceRefreshEvidence: input.forceRefreshEvidence,
        signal,
      }),
    );
    await heartbeat(target, lease);
  }

  return coverResults;
}

async function finishSkipped(params: {
  target: DistillationTargetStateRow;
  lease: TargetLease;
  outcomeKind: string;
  candidateCount: number;
  coverResults: CoverResult[];
}): Promise<DistillationPipelineTargetResult> {
  await requireLease(
    finishDistillationTargetState({
      id: params.target.id,
      status: "skipped",
      outcomeKind: params.outcomeKind,
      candidateCount: params.candidateCount,
      knowledgeIds: [],
      metadata: {
        coverEvidenceStatusCounts: coverStatusCounts(params.coverResults),
      },
      lease: params.lease,
    }),
    params.target,
    "finish-skipped",
  );
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
  const lease = leaseFromTargetState(target);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, groupedConfig.distillation.targetTimeoutMs);

  try {
    const selection = await loadOrRunFindCandidate(target, lease, input, controller.signal);
    const candidateIds = selection.candidateIds;
    const candidateCount = selection.candidateCount;
    if (candidateIds.length === 0) {
      return finishSkipped({
        target,
        lease,
        outcomeKind: "no_candidate",
        candidateCount,
        coverResults: [],
      });
    }

    const coverResults = await runOrResumeCoverEvidence(
      target,
      lease,
      input,
      controller.signal,
      candidateIds,
    );

    const ready = coverResults.filter((result) => result.status === "knowledge_ready");
    const retryable = coverResults.filter((result) => result.retryable);
    if (ready.length === 0 && retryable.length > 0) {
      await requireLease(
        pauseDistillationTargetState({
          id: target.id,
          reason: "cover_evidence_retryable",
          retryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
          metadata: {
            coverEvidenceStatusCounts: coverStatusCounts(coverResults),
            retryableCoverEvidenceIds: retryable.map((result) => result.coverEvidenceResultId),
          },
          lease,
        }),
        target,
        "pause-cover-evidence-retryable",
      );
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
        lease,
        outcomeKind: "all_rejected",
        candidateCount,
        coverResults,
      });
    }

    await updatePhase(target, lease, "finalizing");
    await heartbeat(target, lease);
    const finalizeResults: FinalizeDistilleResult[] = [];
    const finalizeErrors: Array<{ coverEvidenceResultId: string; error: string }> = [];
    for (const result of ready) {
      try {
        finalizeResults.push(
          await runFinalizeDistille({
            coverEvidenceResultId: result.coverEvidenceResultId,
            write: true,
            signal: controller.signal,
          }),
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        finalizeErrors.push({
          coverEvidenceResultId: result.coverEvidenceResultId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await heartbeat(target, lease);
    }

    const stored = finalizeResults.filter(
      (result) => result.status === "stored" && result.knowledgeId,
    );
    const knowledgeIds = stored
      .map((result) => result.knowledgeId)
      .filter((id): id is string => Boolean(id));
    if (knowledgeIds.length === 0) {
      await requireLease(
        finishDistillationTargetState({
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
          lease,
        }),
        target,
        "finish-finalize-failed",
      );
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
    await requireLease(
      finishDistillationTargetState({
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
          resumedFindCandidate: selection.reused,
        },
        lease,
      }),
      target,
      "finish-completed",
    );
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
    const candidateCount = await listFindCandidateResultsByTargetStateId(target.id)
      .then((rows) => rows.length)
      .catch(() => 0);
    if (timedOut || isAbortError(error)) {
      const timeoutMessage = targetTimeoutMessage(target);
      const timeoutMetadata = {
        pipelineError: "target_timeout",
        timeoutMs: groupedConfig.distillation.targetTimeoutMs,
        attemptCount: target.attemptCount,
        maxAttempts: APP_CONSTANTS.distillationTargetMaxAttempts,
      };
      if (target.attemptCount >= APP_CONSTANTS.distillationTargetMaxAttempts) {
        const skipped = await finishDistillationTargetState({
          id: target.id,
          status: "skipped",
          outcomeKind: "target_timeout_retry_limit_exceeded",
          error: timeoutMessage,
          candidateCount,
          knowledgeIds: [],
          metadata: timeoutMetadata,
          lease,
        });
        return {
          targetStateId: target.id,
          targetKind: target.targetKind,
          targetKey: target.targetKey,
          status: skipped ? "skipped" : "failed",
          outcomeKind: skipped ? "target_timeout_retry_limit_exceeded" : "lease_lost",
          candidateCount,
          knowledgeIds: [],
          coverEvidence: [],
          finalize: [],
          error: skipped ? timeoutMessage : "distillation target lease lost during timeout skip",
        };
      }

      const paused = await pauseDistillationTargetState({
        id: target.id,
        reason: "target_timeout",
        retryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
        metadata: timeoutMetadata,
        lease,
      });
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: paused ? "paused" : "failed",
        outcomeKind: paused ? "target_timeout" : "lease_lost",
        candidateCount,
        knowledgeIds: [],
        coverEvidence: [],
        finalize: [],
        error: paused ? timeoutMessage : "distillation target lease lost during timeout pause",
      };
    }

    const paused = await pauseDistillationTargetState({
      id: target.id,
      reason: message,
      retryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
      metadata: {
        pipelineError: message,
      },
      lease,
    });
    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      status: paused ? "paused" : "failed",
      outcomeKind: paused ? "pipeline_paused" : "lease_lost",
      candidateCount,
      knowledgeIds: [],
      coverEvidence: [],
      finalize: [],
      error: paused ? message : "distillation target lease lost during pipeline pause",
    };
  } finally {
    clearTimeout(timer);
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
