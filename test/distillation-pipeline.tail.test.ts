import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { runDistillationPipeline } from "../src/modules/distillationPipeline/runner.js";

const mocks = vi.hoisted(() => ({
  refreshDistillationTargetInventory: vi.fn(),
  recoverStaleDistillationTargets: vi.fn(),
  releaseRetryablePausedDistillationTargets: vi.fn(),
  claimDistillationTargetStateById: vi.fn(),
  claimNextDistillationTargetState: vi.fn(),
  findNextFindCandidateTargetState: vi.fn(),
  claimFindCandidateTargetStateById: vi.fn(),
  hasRunningFindCandidateTargetState: vi.fn(),
  updateDistillationTargetPhase: vi.fn(),
  updateDistillationTargetHeartbeat: vi.fn(),
  finishDistillationTargetState: vi.fn(),
  pauseDistillationTargetState: vi.fn(),
  releaseDistillationTargetState: vi.fn(),
  leaseFromTargetState: vi.fn(),
  runFindCandidate: vi.fn(),
  decideFindCandidateSchedule: vi.fn(),
  isRateLimitError: vi.fn(),
  recordProviderRateLimit: vi.fn(),
  recordProviderUsage: vi.fn(),
  listFindCandidateResultsByTargetStateId: vi.fn(),
  runCoverEvidenceForCandidate: vi.fn(),
  listCoverEvidenceResultsByTargetStateId: vi.fn(),
  coverEvidenceResultFromRow: vi.fn(),
  saveCoverEvidenceResult: vi.fn(),
  runFinalizeDistille: vi.fn(),
  listKnowledgeIdsByTargetStateId: vi.fn(),
}));

vi.mock("../src/modules/selectDistillationTarget/inventory.service.js", () => ({
  refreshDistillationTargetInventory: mocks.refreshDistillationTargetInventory,
}));

vi.mock("../src/modules/selectDistillationTarget/repository.js", () => ({
  DEFAULT_DISTILLATION_TARGET_VERSION: "test-version",
  recoverStaleDistillationTargets: mocks.recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets: mocks.releaseRetryablePausedDistillationTargets,
  claimDistillationTargetStateById: mocks.claimDistillationTargetStateById,
  claimNextDistillationTargetState: mocks.claimNextDistillationTargetState,
  findNextFindCandidateTargetState: mocks.findNextFindCandidateTargetState,
  claimFindCandidateTargetStateById: mocks.claimFindCandidateTargetStateById,
  hasRunningFindCandidateTargetState: mocks.hasRunningFindCandidateTargetState,
  updateDistillationTargetPhase: mocks.updateDistillationTargetPhase,
  updateDistillationTargetHeartbeat: mocks.updateDistillationTargetHeartbeat,
  finishDistillationTargetState: mocks.finishDistillationTargetState,
  pauseDistillationTargetState: mocks.pauseDistillationTargetState,
  releaseDistillationTargetState: mocks.releaseDistillationTargetState,
  leaseFromTargetState: mocks.leaseFromTargetState,
}));

vi.mock("../src/modules/findCandidate/domain.js", () => ({
  runFindCandidate: mocks.runFindCandidate,
}));

vi.mock("../src/modules/findCandidate/find-candidate-scheduler.service.js", () => ({
  decideFindCandidateSchedule: mocks.decideFindCandidateSchedule,
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  listFindCandidateResultsByTargetStateId: mocks.listFindCandidateResultsByTargetStateId,
}));

vi.mock("../src/modules/llm/provider-pressure.service.js", () => ({
  isRateLimitError: mocks.isRateLimitError,
  recordProviderRateLimit: mocks.recordProviderRateLimit,
  recordProviderUsage: mocks.recordProviderUsage,
}));

vi.mock("../src/modules/coverEvidence/repository.js", () => ({
  listCoverEvidenceResultsByTargetStateId: mocks.listCoverEvidenceResultsByTargetStateId,
  coverEvidenceResultFromRow: mocks.coverEvidenceResultFromRow,
  saveCoverEvidenceResult: mocks.saveCoverEvidenceResult,
}));

vi.mock("../src/modules/coverEvidence/runner.js", () => ({
  runCoverEvidenceForCandidate: mocks.runCoverEvidenceForCandidate,
}));

vi.mock("../src/modules/finalizeDistille/domain.js", () => ({
  runFinalizeDistille: mocks.runFinalizeDistille,
}));

vi.mock("../src/modules/finalizeDistille/repository.js", () => ({
  listKnowledgeIdsByTargetStateId: mocks.listKnowledgeIdsByTargetStateId,
}));

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    targetKind: "wiki_file",
    targetKey: "pipeline.md",
    sourceUri: "/wiki/pages/pipeline.md",
    distillationVersion: "test-version",
    status: "running",
    phase: "selected",
    priorityGroup: "wiki",
    sortKey: "pipeline.md",
    attemptCount: 1,
    lockedBy: "worker",
    lockedAt: new Date(),
    heartbeatAt: new Date(),
    nextRetryAt: null,
    lastError: null,
    lastOutcomeKind: null,
    candidateCount: 0,
    knowledgeIds: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

describe("runDistillationPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.distillation.coverEvidenceConcurrency = 1;
    mocks.refreshDistillationTargetInventory.mockResolvedValue({});
    mocks.recoverStaleDistillationTargets.mockResolvedValue({});
    mocks.releaseRetryablePausedDistillationTargets.mockResolvedValue({});
    mocks.claimDistillationTargetStateById.mockResolvedValue(null);
    mocks.claimNextDistillationTargetState.mockResolvedValue(targetRow());
    mocks.findNextFindCandidateTargetState.mockResolvedValue(null);
    mocks.claimFindCandidateTargetStateById.mockResolvedValue(null);
    mocks.hasRunningFindCandidateTargetState.mockResolvedValue(false);
    mocks.updateDistillationTargetPhase.mockResolvedValue({});
    mocks.updateDistillationTargetHeartbeat.mockResolvedValue({});
    mocks.finishDistillationTargetState.mockResolvedValue({});
    mocks.pauseDistillationTargetState.mockResolvedValue({});
    mocks.releaseDistillationTargetState.mockResolvedValue({});
    mocks.leaseFromTargetState.mockImplementation((row) => ({
      targetStateId: row.id,
      lockedBy: row.lockedBy,
      attemptCount: row.attemptCount,
    }));
    mocks.listFindCandidateResultsByTargetStateId.mockResolvedValue([]);
    mocks.listCoverEvidenceResultsByTargetStateId.mockResolvedValue([]);
    mocks.coverEvidenceResultFromRow.mockImplementation((row) => ({
      schemaVersion: 1,
      coverEvidenceResultId: row.id,
      findCandidateId: row.id,
      status: row.status,
      stage: row.stage,
      candidate: null,
      references: [],
      duplicateRefs: [],
      toolEvents: [],
      reason: row.reason ?? null,
    }));
    mocks.saveCoverEvidenceResult.mockResolvedValue({});
    mocks.listKnowledgeIdsByTargetStateId.mockResolvedValue(["knowledge-1"]);
    mocks.runFindCandidate.mockResolvedValue({
      targetStateId: "target-1",
      targetKind: "wiki_file",
      targetKey: "pipeline.md",
      callerMode: "storage",
      candidates: [{ title: "T", content: "B" }],
      insertedIds: ["candidate-1"],
      readRanges: [{ from: 0, toExclusive: 100 }],
    });
    mocks.runCoverEvidenceForCandidate.mockResolvedValue({
      coverEvidenceResultId: "candidate-1",
      findCandidateId: "candidate-1",
      status: "knowledge_ready",
      stage: "final",
      retryable: false,
      reason: null,
    });
    mocks.runFinalizeDistille.mockResolvedValue({
      coverEvidenceResultId: "candidate-1",
      knowledgeId: "knowledge-1",
      status: "stored",
      embeddingStatus: "stored",
      sourceReferenceCount: 1,
      sourceLinkCount: 0,
      reason: null,
    });
    mocks.decideFindCandidateSchedule.mockResolvedValue({
      shouldWait: false,
      waitMs: 0,
      reason: "ready",
      diagnostics: {
        provider: "openai",
        model: "gpt-5-4-mini",
        compileCount: 0,
        interactiveLlmCount: 0,
        lastCompileAgeSeconds: null,
        lastBackgroundAgeSeconds: null,
      },
    });
    mocks.isRateLimitError.mockReturnValue(false);
    mocks.recordProviderRateLimit.mockResolvedValue(undefined);
    mocks.recordProviderUsage.mockResolvedValue(undefined);
  });

  test("times out one candidate and completes after next run processes another candidate", async () => {
    vi.useFakeTimers();
    try {
      mocks.runFindCandidate.mockResolvedValue({
        targetStateId: "target-1",
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        callerMode: "storage",
        candidates: [
          { title: "Slow", content: "Candidate that does not finish" },
          { title: "Ready", content: "Candidate that should still be finalized" },
        ],
        insertedIds: ["candidate-slow", "candidate-ready"],
        readRanges: [{ from: 0, toExclusive: 100 }],
      });
      mocks.runCoverEvidenceForCandidate.mockImplementation(({ findCandidateId, signal }) => {
        if (findCandidateId === "candidate-slow") {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        }

        return Promise.resolve({
          coverEvidenceResultId: "candidate-ready",
          findCandidateId: "candidate-ready",
          status: "knowledge_ready",
          stage: "final",
          retryable: false,
          reason: null,
        });
      });
      mocks.runFinalizeDistille.mockResolvedValue({
        coverEvidenceResultId: "candidate-ready",
        knowledgeId: "knowledge-ready",
        status: "stored",
        embeddingStatus: "stored",
        sourceReferenceCount: 1,
        sourceLinkCount: 0,
        reason: null,
      });

      const firstPending = runDistillationPipeline({ write: true, refresh: false, limit: 1 });
      await vi.advanceTimersByTimeAsync(600_000);
      const first = await firstPending;

      expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "candidate-slow",
          result: expect.objectContaining({
            status: "provider_failed",
            reason: "candidate_timeout",
          }),
        }),
      );
      expect(first.results[0]).toMatchObject({
        status: "paused",
        outcomeKind: "cover_evidence_checkpoint",
      });

      mocks.listFindCandidateResultsByTargetStateId.mockResolvedValue([
        {
          id: "candidate-slow",
          targetStateId: "target-1",
          candidateIndex: 0,
          title: "Slow",
          content: "Candidate that does not finish",
          origin: { candidateType: "rule" },
          status: "selected",
          createdAt: new Date(),
          updatedAt: new Date(),
          targetKind: "wiki_file",
          targetKey: "pipeline.md",
          sourceUri: "/wiki/pages/pipeline.md",
        },
        {
          id: "candidate-ready",
          targetStateId: "target-1",
          candidateIndex: 1,
          title: "Ready",
          content: "Candidate that should still be finalized",
          origin: { candidateType: "rule" },
          status: "selected",
          createdAt: new Date(),
          updatedAt: new Date(),
          targetKind: "wiki_file",
          targetKey: "pipeline.md",
          sourceUri: "/wiki/pages/pipeline.md",
        },
      ]);
      mocks.listCoverEvidenceResultsByTargetStateId.mockResolvedValue([
        {
          id: "candidate-slow",
          status: "provider_failed",
          stage: "final",
          reason: "candidate_timeout",
          updatedAt: new Date(),
        },
      ]);
      mocks.listKnowledgeIdsByTargetStateId.mockResolvedValue(["knowledge-ready"]);
      const second = await runDistillationPipeline({ write: true, refresh: false, limit: 1 });

      expect(mocks.runCoverEvidenceForCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ findCandidateId: "candidate-ready" }),
      );
      expect(mocks.runFinalizeDistille).toHaveBeenCalledWith(
        expect.objectContaining({ coverEvidenceResultId: "candidate-ready" }),
      );
      expect(second.results[0]).toMatchObject({
        status: "completed",
        outcomeKind: "knowledge_finalized_with_retryable_rejections",
        knowledgeIds: ["knowledge-ready"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("skips target when no candidates are found", async () => {
    mocks.runFindCandidate.mockResolvedValue({
      targetStateId: "target-1",
      targetKind: "wiki_file",
      targetKey: "pipeline.md",
      callerMode: "storage",
      candidates: [],
      insertedIds: [],
      readRanges: [],
    });

    const result = await runDistillationPipeline({ write: true, refresh: false, limit: 1 });

    expect(result.results[0]).toMatchObject({
      status: "skipped",
      outcomeKind: "no_candidate",
    });
    expect(mocks.finishDistillationTargetState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        outcomeKind: "no_candidate",
      }),
    );
  });

  test("processes cover evidence in batches when concurrency is enabled", async () => {
    groupedConfig.distillation.coverEvidenceConcurrency = 2;
    mocks.listFindCandidateResultsByTargetStateId.mockResolvedValue([
      {
        id: "candidate-1",
        targetStateId: "target-1",
        candidateIndex: 0,
        title: "C1",
        content: "Candidate 1",
        origin: { candidateType: "rule" },
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        sourceUri: "/wiki/pages/pipeline.md",
      },
      {
        id: "candidate-2",
        targetStateId: "target-1",
        candidateIndex: 1,
        title: "C2",
        content: "Candidate 2",
        origin: { candidateType: "rule" },
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        sourceUri: "/wiki/pages/pipeline.md",
      },
      {
        id: "candidate-3",
        targetStateId: "target-1",
        candidateIndex: 2,
        title: "C3",
        content: "Candidate 3",
        origin: { candidateType: "rule" },
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        sourceUri: "/wiki/pages/pipeline.md",
      },
    ]);
    mocks.runCoverEvidenceForCandidate.mockImplementation(async ({ findCandidateId }) => ({
      coverEvidenceResultId: findCandidateId,
      findCandidateId,
      status: "knowledge_ready",
      stage: "final",
      retryable: false,
      reason: null,
    }));
    mocks.runFinalizeDistille.mockImplementation(async ({ coverEvidenceResultId }) => ({
      coverEvidenceResultId,
      knowledgeId: `knowledge-${coverEvidenceResultId}`,
      status: "stored",
      embeddingStatus: "stored",
      sourceReferenceCount: 1,
      sourceLinkCount: 0,
      reason: null,
    }));

    const result = await runDistillationPipeline({ write: true, refresh: false, limit: 1 });

    expect(mocks.runCoverEvidenceForCandidate).toHaveBeenCalledTimes(2);
    expect(result.results[0]).toMatchObject({
      status: "paused",
      outcomeKind: "cover_evidence_checkpoint",
      candidateCount: 3,
    });
    expect(mocks.pauseDistillationTargetState).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "cover_evidence_checkpoint",
        metadata: expect.objectContaining({ remainingCandidates: 1, candidateCount: 3 }),
      }),
    );
  });

  test("starts cover evidence candidates concurrently but finalizes after the batch resolves", async () => {
    groupedConfig.distillation.coverEvidenceConcurrency = 2;
    mocks.listFindCandidateResultsByTargetStateId.mockResolvedValue([
      {
        id: "candidate-1",
        targetStateId: "target-1",
        candidateIndex: 0,
        title: "C1",
        content: "Candidate 1",
        origin: { candidateType: "rule" },
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        sourceUri: "/wiki/pages/pipeline.md",
      },
      {
        id: "candidate-2",
        targetStateId: "target-1",
        candidateIndex: 1,
        title: "C2",
        content: "Candidate 2",
        origin: { candidateType: "rule" },
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        sourceUri: "/wiki/pages/pipeline.md",
      },
    ]);
    const coverResolvers: Array<(value: unknown) => void> = [];
    mocks.runCoverEvidenceForCandidate.mockImplementation(
      ({ findCandidateId }) =>
        new Promise((resolve) => {
          coverResolvers.push(() =>
            resolve({
              coverEvidenceResultId: findCandidateId,
              findCandidateId,
              status: "knowledge_ready",
              stage: "final",
              retryable: false,
              reason: null,
            }),
          );
        }),
    );

    const pipeline = runDistillationPipeline({ write: true, refresh: false, limit: 1 });

    await vi.waitFor(() => {
      expect(mocks.runCoverEvidenceForCandidate).toHaveBeenCalledTimes(2);
    });
    expect(mocks.runFinalizeDistille).not.toHaveBeenCalled();

    for (const resolveCover of coverResolvers) resolveCover({});

    const result = await pipeline;
    expect(result.results[0]).toMatchObject({
      status: "completed",
      outcomeKind: "knowledge_finalized",
    });
    expect(mocks.runFinalizeDistille).toHaveBeenCalledTimes(2);
  });

  test("finalizes existing ready cover evidence results when resuming without pending candidates", async () => {
    mocks.listFindCandidateResultsByTargetStateId.mockResolvedValue([
      {
        id: "candidate-1",
        targetStateId: "target-1",
        candidateIndex: 0,
        title: "C1",
        content: "Candidate 1",
        origin: { candidateType: "rule" },
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "wiki_file",
        targetKey: "pipeline.md",
        sourceUri: "/wiki/pages/pipeline.md",
      },
    ]);
    mocks.listCoverEvidenceResultsByTargetStateId.mockResolvedValue([
      {
        id: "candidate-1",
        targetStateId: "target-1",
        status: "knowledge_ready",
        stage: "final",
        retryable: false,
        reason: null,
      },
    ]);
    mocks.listKnowledgeIdsByTargetStateId
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["knowledge-1"]);

    const result = await runDistillationPipeline({ write: true, refresh: false, limit: 1 });

    expect(mocks.runCoverEvidenceForCandidate).not.toHaveBeenCalled();
    expect(mocks.runFinalizeDistille).toHaveBeenCalledWith({
      coverEvidenceResultId: "candidate-1",
      write: true,
    });
    expect(result.results[0]).toMatchObject({
      status: "completed",
      outcomeKind: "knowledge_finalized",
    });
  });

  test("skips retry-exhausted target after pipeline error", async () => {
    mocks.claimNextDistillationTargetState.mockResolvedValue(targetRow({ attemptCount: 3 }));
    mocks.runFindCandidate.mockRejectedValue(new Error("The operation timed out."));

    const result = await runDistillationPipeline({ write: true, refresh: false, limit: 1 });

    expect(result.results[0]).toMatchObject({
      status: "skipped",
      outcomeKind: "pipeline_retry_limit_exceeded",
      error: "The operation timed out.",
    });
    expect(mocks.finishDistillationTargetState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "target-1",
        status: "skipped",
        outcomeKind: "pipeline_retry_limit_exceeded",
        error: "The operation timed out.",
        metadata: expect.objectContaining({
          retryLimitExceeded: true,
          maxAttempts: 3,
        }),
      }),
    );
    expect(mocks.pauseDistillationTargetState).not.toHaveBeenCalled();
  });
});
