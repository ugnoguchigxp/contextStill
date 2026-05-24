import { groupedConfig } from "../../config.js";
import { APP_CONSTANTS } from "../../constants.js";
import { parseWebIngestTargetMetadata } from "../../shared/schemas/distillation-target-metadata.schema.js";
import {
  type CoverEvidenceResultRow,
  coverEvidenceResultFromRow,
  listCoverEvidenceResultsByTargetStateId,
  saveCoverEvidenceResult,
} from "../coverEvidence/repository.js";
import { runCoverEvidenceForCandidate } from "../coverEvidence/runner.js";
import type { DistillationProviderSetting } from "../distillation/distillation-runtime.service.js";
import {
  PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  assessProcedureQuality,
  hasSkillLikeProcedureBody,
  validateCandidateQualityForStorage,
} from "../distillation/procedure-quality.js";
import { type FinalizeDistilleResult, runFinalizeDistille } from "../finalizeDistille/domain.js";
import { listKnowledgeIdsByTargetStateId } from "../finalizeDistille/repository.js";
import { runFindCandidate } from "../findCandidate/domain.js";
import {
  decideFindCandidateSchedule,
  type FindCandidateScheduleDecision,
} from "../findCandidate/find-candidate-scheduler.service.js";
import {
  type FindCandidateResultRow,
  listFindCandidateResultsByTargetStateId,
} from "../findCandidate/repository.js";
import {
  isRateLimitError,
  recordProviderRateLimit,
  recordProviderUsage,
} from "../llm/provider-pressure.service.js";
import type { DistillationTargetKind } from "../selectDistillationTarget/domain.js";
import { refreshDistillationTargetInventory } from "../selectDistillationTarget/inventory.service.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
  type TargetLease,
  claimFindCandidateTargetStateById,
  claimDistillationTargetStateById,
  claimNextDistillationTargetState,
  findNextFindCandidateTargetState,
  finishDistillationTargetState,
  hasRunningFindCandidateTargetState,
  leaseFromTargetState,
  pauseDistillationTargetState,
  recoverStaleDistillationTargets,
  releaseDistillationTargetState,
  releaseRetryablePausedDistillationTargets,
  updateDistillationTargetHeartbeat,
  updateDistillationTargetPhase,
  updateDistillationTargetSource,
} from "../selectDistillationTarget/repository.js";
import { researchWebSourceToMarkdown } from "../sources/web/source-research.service.js";

export type DistillationPipelineInput = {
  kind?: "auto" | "wiki" | "vibe" | "candidate" | "web";
  limit?: number;
  targetStateId?: string;
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
  status: "completed" | "skipped" | "paused" | "failed" | "pending";
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
  deferred?: FindCandidateScheduleDecision;
};

type CandidateProcessing = {
  coverResults: CoverResult[];
  finalizeResults: FinalizeDistilleResult[];
  finalizeErrors: Array<{ coverEvidenceResultId: string; error: string }>;
  remainingCandidates: number;
};

type ScheduledFindCandidateTargetKind = "wiki_file" | "vibe_memory" | "web_ingest";

const retryableCoverStatuses = new Set<string>([
  "reprocess_requested",
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);
const CHECKPOINT_RETRY_DELAY_SECONDS = 1;
const CHECKPOINT_PAUSE_REASON = "cover_evidence_checkpoint";
const PARALLEL_FIND_CANDIDATE_OUTCOME = "find_candidate_ready";

function asScheduledFindCandidateTargetKind(
  value: DistillationTargetStateRow["targetKind"],
): ScheduledFindCandidateTargetKind | null {
  if (value === "wiki_file" || value === "vibe_memory" || value === "web_ingest") {
    return value;
  }
  return null;
}

function targetKindFilter(
  kind: DistillationPipelineInput["kind"],
): DistillationTargetKind | undefined {
  if (kind === "candidate") return "knowledge_candidate";
  if (kind === "web") return "web_ingest";
  if (kind === "wiki") return "wiki_file";
  if (kind === "vibe") return "vibe_memory";
  return undefined;
}

function findCandidateTargetKinds(
  kind: DistillationPipelineInput["kind"],
): ScheduledFindCandidateTargetKind[] {
  if (kind === "candidate") return [];
  if (kind === "web") return ["web_ingest"];
  if (kind === "wiki") return ["wiki_file"];
  if (kind === "vibe") return ["vibe_memory"];
  return ["web_ingest", "wiki_file", "vibe_memory"];
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

function candidateTimeoutMessage(findCandidateId: string): string {
  return `distillation candidate timed out after ${groupedConfig.distillation.candidateTimeoutMs}ms: ${findCandidateId}`;
}

function candidateTimeoutResult(findCandidateId: string): CoverResult {
  return {
    coverEvidenceResultId: findCandidateId,
    findCandidateId,
    status: "provider_failed",
    stage: "final",
    retryable: true,
    reason: "candidate_timeout",
  };
}

function findCandidateWorker(input: DistillationPipelineInput): string | undefined {
  const base = input.worker?.trim();
  return base ? `${base}:find-candidate` : undefined;
}

async function saveCandidateTimeoutResult(findCandidateId: string): Promise<CoverResult> {
  await saveCoverEvidenceResult({
    id: findCandidateId,
    result: {
      schemaVersion: 1,
      status: "provider_failed",
      stage: "final",
      candidate: null,
      references: [],
      duplicateRefs: [],
      toolEvents: [],
      reason: "candidate_timeout",
    },
  });
  return candidateTimeoutResult(findCandidateId);
}

async function runWithCandidateTimeout<T>(
  findCandidateId: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, groupedConfig.distillation.candidateTimeoutMs);

  try {
    return await task(controller.signal);
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      throw Object.assign(new Error(candidateTimeoutMessage(findCandidateId)), {
        name: "AbortError",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function coverResultFromRow(row: CoverEvidenceResultRow): CoverResult {
  const result = coverEvidenceResultFromRow(row);
  if (result.status === "knowledge_ready" && result.candidate?.type === "rule") {
    const validation = validateCandidateQualityForStorage(result.candidate);
    if (validation.action === "reject") {
      return {
        coverEvidenceResultId: row.id,
        findCandidateId: row.id,
        status: "insufficient",
        stage: result.stage,
        retryable: false,
        reason: validation.reason,
      };
    }
  }
  if (result.status === "knowledge_ready" && result.candidate?.type === "procedure") {
    const decision = assessProcedureQuality({
      title: result.candidate.title,
      body: result.candidate.body,
    });
    if (!hasSkillLikeProcedureBody(result.candidate.body) && decision.action !== "demote_to_rule") {
      return {
        coverEvidenceResultId: row.id,
        findCandidateId: row.id,
        status: "insufficient",
        stage: result.stage,
        retryable: false,
        reason:
          decision.action === "reject_insufficient"
            ? decision.reason
            : PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
      };
    }
  }
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

function parallelLaneBusyDecision(
  scheduleDecision: FindCandidateScheduleDecision,
): FindCandidateScheduleDecision {
  return {
    ...scheduleDecision,
    shouldWait: true,
    waitMs: Math.max(1, groupedConfig.distillation.findCandidateMinIntervalSeconds) * 1000,
    reason: "parallel_lane_busy",
  };
}

async function heartbeat(target: DistillationTargetStateRow, lease: TargetLease): Promise<void> {
  await requireLease(updateDistillationTargetHeartbeat(target.id, lease), target, "heartbeat");
}

async function loadOrRunFindCandidate(
  target: DistillationTargetStateRow,
  lease: TargetLease,
  input: DistillationPipelineInput,
  signal?: AbortSignal,
): Promise<CandidateSelection> {
  const existing = await listFindCandidateResultsByTargetStateId(target.id);
  if (existing.length > 0) {
    return {
      candidateIds: existing.map((row: FindCandidateResultRow) => row.id),
      candidateCount: existing.length,
      reused: true,
    };
  }

  if (target.targetKind === "knowledge_candidate") {
    return {
      candidateIds: [],
      candidateCount: 0,
      reused: true,
    };
  }

  const scheduledTargetKind = asScheduledFindCandidateTargetKind(target.targetKind);
  if (!scheduledTargetKind) {
    return {
      candidateIds: [],
      candidateCount: 0,
      reused: true,
    };
  }

  const scheduleDecision = await decideFindCandidateSchedule({
    targetKind: scheduledTargetKind,
    providerOverride: input.provider,
  });
  if (scheduleDecision.shouldWait) {
    return {
      candidateIds: [],
      candidateCount: 0,
      reused: false,
      deferred: scheduleDecision,
    };
  }

  if (groupedConfig.distillation.findCandidateBackgroundEnabled) {
    const parallelLaneBusy = await hasRunningFindCandidateTargetState({
      distillationVersion: target.distillationVersion,
      excludeTargetStateId: target.id,
    });
    if (parallelLaneBusy) {
      return {
        candidateIds: [],
        candidateCount: 0,
        reused: false,
        deferred: parallelLaneBusyDecision(scheduleDecision),
      };
    }
  }

  return runFindCandidateForClaimedTarget(target, lease, input, scheduleDecision, signal);
}

async function runFindCandidateForClaimedTarget(
  target: DistillationTargetStateRow,
  lease: TargetLease,
  input: DistillationPipelineInput,
  scheduleDecision: FindCandidateScheduleDecision,
  signal?: AbortSignal,
): Promise<CandidateSelection> {
  void recordProviderUsage({
    provider: scheduleDecision.diagnostics.provider,
    model: scheduleDecision.diagnostics.model,
    source: "find-candidate",
    kind: "background",
  }).catch(() => undefined);

  const phaseRow = await updateDistillationTargetPhase({
    id: target.id,
    phase: "finding_candidate",
    distillationVersion: target.distillationVersion,
    requireNoOtherRunningFindCandidate: true,
    lease,
  });
  if (!phaseRow) {
    return {
      candidateIds: [],
      candidateCount: 0,
      reused: false,
      deferred: parallelLaneBusyDecision(scheduleDecision),
    };
  }
  await heartbeat(target, lease);
  let findResult: Awaited<ReturnType<typeof runFindCandidate>>;
  try {
    findResult = await runFindCandidate({
      targetStateId: target.id,
      provider: input.provider,
      callerMode: "storage",
      signal,
    });
  } catch (error) {
    if (isRateLimitError(error)) {
      void recordProviderRateLimit({
        provider: scheduleDecision.diagnostics.provider,
        model: scheduleDecision.diagnostics.model,
        source: "find-candidate",
        error,
      }).catch(() => undefined);
    }
    throw error;
  }
  return {
    candidateIds: findResult.insertedIds ?? [],
    candidateCount: findResult.candidates.length,
    reused: false,
  };
}

async function runParallelFindCandidateTarget(
  target: DistillationTargetStateRow,
  input: DistillationPipelineInput,
  scheduleDecision: FindCandidateScheduleDecision,
): Promise<DistillationPipelineTargetResult> {
  const lease = leaseFromTargetState(target);
  try {
    await ensureWebIngestSourcePrepared({ target, lease, input });
    const selection = await runFindCandidateForClaimedTarget(
      target,
      lease,
      input,
      scheduleDecision,
      undefined,
    );
    if (selection.deferred) {
      const retryDelaySeconds = Math.max(1, Math.ceil(selection.deferred.waitMs / 1000));
      await requireLease(
        pauseDistillationTargetState({
          id: target.id,
          reason: `find_candidate_throttled:${selection.deferred.reason}`,
          retryDelaySeconds,
          metadata: {
            retryDelaySeconds,
            scheduleDecision: selection.deferred,
            parallelFindCandidate: true,
          },
          lease,
        }),
        target,
        "pause-find-candidate-throttled",
      );
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: "paused",
        outcomeKind: "find_candidate_throttled",
        candidateCount: 0,
        knowledgeIds: [],
        coverEvidence: [],
        finalize: [],
      };
    }
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

    await requireLease(
      releaseDistillationTargetState({
        id: target.id,
        phase: "covering_evidence",
        outcomeKind: PARALLEL_FIND_CANDIDATE_OUTCOME,
        candidateCount,
        metadata: {
          candidateIds,
          parallelFindCandidate: true,
          scheduleDecision,
        },
        lease,
      }),
      target,
      "release-find-candidate-ready",
    );

    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      status: "pending",
      outcomeKind: PARALLEL_FIND_CANDIDATE_OUTCOME,
      candidateCount,
      knowledgeIds: [],
      coverEvidence: [],
      finalize: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const candidateCount = await listFindCandidateResultsByTargetStateId(target.id)
      .then((rows) => rows.length)
      .catch(() => 0);
    if (target.attemptCount >= APP_CONSTANTS.distillationTargetMaxAttempts) {
      const skipped = await finishDistillationTargetState({
        id: target.id,
        status: "skipped",
        outcomeKind: "pipeline_retry_limit_exceeded",
        error: message,
        candidateCount,
        knowledgeIds: [],
        metadata: {
          pipelineError: message,
          retryLimitExceeded: true,
          maxAttempts: APP_CONSTANTS.distillationTargetMaxAttempts,
          parallelFindCandidate: true,
        },
        lease,
      });
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: skipped ? "skipped" : "failed",
        outcomeKind: skipped ? "pipeline_retry_limit_exceeded" : "lease_lost",
        candidateCount,
        knowledgeIds: [],
        coverEvidence: [],
        finalize: [],
        error: skipped ? message : "distillation target lease lost during retry-limit skip",
      };
    }
    const paused = await pauseDistillationTargetState({
      id: target.id,
      reason: message,
      retryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
      metadata: {
        pipelineError: message,
        parallelFindCandidate: true,
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
  }
}

async function runParallelFindCandidateLane(
  input: DistillationPipelineInput,
  distillationVersion: string,
): Promise<DistillationPipelineTargetResult | null> {
  if (input.targetStateId?.trim()) return null;
  if (!groupedConfig.distillation.findCandidateBackgroundEnabled) return null;

  const targetKinds = findCandidateTargetKinds(input.kind);
  if (targetKinds.length === 0) return null;

  const preview = await findNextFindCandidateTargetState({
    distillationVersion,
    targetKinds,
  });
  if (!preview) return null;

  const scheduledTargetKind = asScheduledFindCandidateTargetKind(preview.targetKind);
  if (!scheduledTargetKind) return null;

  const scheduleDecision = await decideFindCandidateSchedule({
    targetKind: scheduledTargetKind,
    providerOverride: input.provider,
  });
  if (scheduleDecision.shouldWait) return null;

  const target = await claimFindCandidateTargetStateById({
    id: preview.id,
    distillationVersion,
    targetKind: scheduledTargetKind,
    worker: findCandidateWorker(input),
  });
  if (!target) return null;

  return runParallelFindCandidateTarget(target, input, scheduleDecision);
}

function sourceUrlForWebIngestTarget(target: DistillationTargetStateRow): string {
  const metadata = parseWebIngestTargetMetadata(target.metadata);
  const sourceUrl = metadata.sourceUrl ?? metadata.sourceWebUrl ?? "";
  if (sourceUrl) return sourceUrl;
  return target.targetKey;
}

async function ensureWebIngestSourcePrepared(params: {
  target: DistillationTargetStateRow;
  lease: TargetLease;
  input: DistillationPipelineInput;
}): Promise<void> {
  const { target, lease, input } = params;
  if (target.targetKind !== "web_ingest") return;

  const metadata = parseWebIngestTargetMetadata(target.metadata);
  const savedWikiTargetKey = metadata.savedWikiTargetKey ?? "";
  if (savedWikiTargetKey) {
    await requireLease(
      updateDistillationTargetSource({
        id: target.id,
        sourceUri: savedWikiTargetKey,
        lease,
      }),
      target,
      "web-source-ready",
    );
    return;
  }

  await updatePhase(target, lease, "researching_source");
  await heartbeat(target, lease);
  const sourceUrl = sourceUrlForWebIngestTarget(target);
  const research = await researchWebSourceToMarkdown({
    url: sourceUrl,
    normalizedUrl: target.targetKey,
    provider: input.provider,
  });
  await updatePhase(target, lease, "writing_source");
  await heartbeat(target, lease);
  await requireLease(
    updateDistillationTargetSource({
      id: target.id,
      sourceUri: research.savedWikiTargetKey,
      metadata: {
        sourceWebUrl: sourceUrl,
        savedWikiSlug: research.savedWikiSlug,
        savedWikiTargetKey: research.savedWikiTargetKey,
        savedWikiPath: research.savedWikiPath,
        researchGeneratedAt: new Date().toISOString(),
        llmProvider: research.llmProvider,
        llmModel: research.llmModel,
        fetchFinalUrl: research.fetchFinalUrl,
      },
      lease,
    }),
    target,
    "web-source-update",
  );
}

async function runOrResumeCandidates(
  target: DistillationTargetStateRow,
  lease: TargetLease,
  input: DistillationPipelineInput,
  candidateIds: string[],
): Promise<CandidateProcessing> {
  await updatePhase(target, lease, "covering_evidence");
  await heartbeat(target, lease);

  const existingRows = await listCoverEvidenceResultsByTargetStateId(target.id);
  const existingByCandidateId = new Map(
    existingRows.map((row) => [row.id, coverResultFromRow(row)] as const),
  );
  const coverResultsByCandidateId = new Map(existingByCandidateId);
  const coverResults: CoverResult[] = [];
  const finalizeResults: FinalizeDistilleResult[] = [];
  const finalizeErrors: Array<{ coverEvidenceResultId: string; error: string }> = [];

  const finalizeReadyCandidate = async (coverResult: CoverResult): Promise<void> => {
    await updatePhase(target, lease, "finalizing");
    await heartbeat(target, lease);
    try {
      finalizeResults.push(
        await runFinalizeDistille({
          coverEvidenceResultId: coverResult.coverEvidenceResultId,
          write: true,
        }),
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      finalizeErrors.push({
        coverEvidenceResultId: coverResult.coverEvidenceResultId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await heartbeat(target, lease);
    await updatePhase(target, lease, "covering_evidence");
  };

  const runCoverOnce = async (findCandidateId: string): Promise<void> => {
    let coverResult: CoverResult;
    const existing = coverResultsByCandidateId.get(findCandidateId);
    if (existing && !input.forceRefreshEvidence && !existing.retryable) {
      coverResult = existing;
    } else {
      try {
        coverResult = await runWithCandidateTimeout(findCandidateId, (signal) =>
          runCoverEvidenceForCandidate({
            targetStateId: target.id,
            findCandidateId,
            provider: input.provider,
            forceRefreshEvidence: input.forceRefreshEvidence,
            signal,
          }),
        );
      } catch (error) {
        if (!isAbortError(error)) {
          throw error;
        }
        coverResult = await saveCandidateTimeoutResult(findCandidateId);
      }
    }
    coverResultsByCandidateId.set(findCandidateId, coverResult);
    await heartbeat(target, lease);

    if (coverResult.status === "knowledge_ready") {
      await finalizeReadyCandidate(coverResult);
    }
  };

  const runCoverBatch = async (candidateBatch: string[]): Promise<void> => {
    if (candidateBatch.length === 0) return;
    if (candidateBatch.length === 1) {
      await runCoverOnce(candidateBatch[0]);
      return;
    }
    await Promise.all(candidateBatch.map((findCandidateId) => runCoverOnce(findCandidateId)));
    await heartbeat(target, lease);
  };

  let remainingCandidates = 0;
  const coverConcurrency = Math.max(1, groupedConfig.distillation.coverEvidenceConcurrency);
  if (input.forceRefreshEvidence) {
    for (let index = 0; index < candidateIds.length; index += coverConcurrency) {
      await runCoverBatch(candidateIds.slice(index, index + coverConcurrency));
    }
  } else {
    const pendingCandidateIds = candidateIds.filter((findCandidateId) => {
      return !coverResultsByCandidateId.has(findCandidateId);
    });
    const nextBatch = pendingCandidateIds.slice(0, coverConcurrency);
    if (nextBatch.length > 0) {
      await runCoverBatch(nextBatch);
    }
    remainingCandidates = Math.max(0, pendingCandidateIds.length - nextBatch.length);
  }

  for (const findCandidateId of candidateIds) {
    const coverResult = coverResultsByCandidateId.get(findCandidateId);
    if (!coverResult) continue;
    coverResults.push(coverResult);
  }

  return { coverResults, finalizeResults, finalizeErrors, remainingCandidates };
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

  try {
    await ensureWebIngestSourcePrepared({ target, lease, input });
    const selection = await loadOrRunFindCandidate(target, lease, input, undefined);
    if (selection.deferred) {
      const retryDelaySeconds = Math.max(1, Math.ceil(selection.deferred.waitMs / 1000));
      await requireLease(
        pauseDistillationTargetState({
          id: target.id,
          reason: `find_candidate_throttled:${selection.deferred.reason}`,
          retryDelaySeconds,
          metadata: {
            retryDelaySeconds,
            scheduleDecision: selection.deferred,
          },
          lease,
        }),
        target,
        "pause-find-candidate-throttled",
      );
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: "paused",
        outcomeKind: "find_candidate_throttled",
        candidateCount: 0,
        knowledgeIds: [],
        coverEvidence: [],
        finalize: [],
      };
    }
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

    const processed = await runOrResumeCandidates(target, lease, input, candidateIds);
    const { coverResults, finalizeResults, finalizeErrors, remainingCandidates } = processed;
    if (remainingCandidates > 0) {
      await requireLease(
        pauseDistillationTargetState({
          id: target.id,
          reason: CHECKPOINT_PAUSE_REASON,
          retryDelaySeconds: CHECKPOINT_RETRY_DELAY_SECONDS,
          metadata: {
            remainingCandidates,
            candidateCount,
          },
          lease,
        }),
        target,
        "pause-cover-evidence-checkpoint",
      );
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: "paused",
        outcomeKind: CHECKPOINT_PAUSE_REASON,
        candidateCount,
        knowledgeIds: [],
        coverEvidence: compactCoverResults(coverResults),
        finalize: finalizeResults,
      };
    }

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

    const knowledgeIds = await listKnowledgeIdsByTargetStateId(target.id);
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
    if (target.attemptCount >= APP_CONSTANTS.distillationTargetMaxAttempts) {
      const skipped = await finishDistillationTargetState({
        id: target.id,
        status: "skipped",
        outcomeKind: "pipeline_retry_limit_exceeded",
        error: message,
        candidateCount,
        knowledgeIds: [],
        metadata: {
          pipelineError: message,
          retryLimitExceeded: true,
          maxAttempts: APP_CONSTANTS.distillationTargetMaxAttempts,
        },
        lease,
      });
      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        status: skipped ? "skipped" : "failed",
        outcomeKind: skipped ? "pipeline_retry_limit_exceeded" : "lease_lost",
        candidateCount,
        knowledgeIds: [],
        coverEvidence: [],
        finalize: [],
        error: skipped ? message : "distillation target lease lost during retry-limit skip",
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

  const requestedTargetStateId = input.targetStateId?.trim();
  if (requestedTargetStateId) {
    const target = await claimDistillationTargetStateById({
      id: requestedTargetStateId,
      distillationVersion,
      targetKind: targetKindFilter(input.kind),
      worker: input.worker,
    });
    if (!target) {
      return {
        distillationVersion,
        processed: 0,
        idle: true,
        results: [],
      };
    }
    return {
      distillationVersion,
      processed: 1,
      idle: false,
      results: [await runClaimedTarget(target, input)],
    };
  }

  const findCandidateLane = runParallelFindCandidateLane(input, distillationVersion);
  const primaryLane = (async (): Promise<DistillationPipelineTargetResult[]> => {
    const results: DistillationPipelineTargetResult[] = [];
    for (let index = 0; index < positiveLimit(input.limit); index += 1) {
      const target = await claimNextDistillationTargetState({
        distillationVersion,
        targetKind: targetKindFilter(input.kind),
        worker: input.worker,
        requireCandidateResultsForSourceTargets:
          groupedConfig.distillation.findCandidateBackgroundEnabled,
      });
      if (!target) break;
      results.push(await runClaimedTarget(target, input));
    }
    return results;
  })();

  const [results, findCandidateResult] = await Promise.all([primaryLane, findCandidateLane]);
  if (findCandidateResult) {
    results.push(findCandidateResult);
  }

  return {
    distillationVersion,
    processed: results.length,
    idle: results.length === 0,
    results,
  };
}
