import { beforeEach, describe, expect, test, vi } from "vitest";
import { runDistillationPipeline } from "../src/modules/distillationPipeline/runner.js";

const mocks = vi.hoisted(() => ({
  refreshDistillationTargetInventory: vi.fn(),
  recoverStaleDistillationTargets: vi.fn(),
  releaseRetryablePausedDistillationTargets: vi.fn(),
  claimNextDistillationTargetState: vi.fn(),
  updateDistillationTargetPhase: vi.fn(),
  updateDistillationTargetHeartbeat: vi.fn(),
  finishDistillationTargetState: vi.fn(),
  pauseDistillationTargetState: vi.fn(),
  runFindCandidate: vi.fn(),
  runCoverEvidenceForCandidate: vi.fn(),
  runFinalizeDistille: vi.fn(),
}));

vi.mock("../src/modules/selectDistillationTarget/inventory.service.js", () => ({
  refreshDistillationTargetInventory: mocks.refreshDistillationTargetInventory,
}));

vi.mock("../src/modules/selectDistillationTarget/repository.js", () => ({
  DEFAULT_DISTILLATION_TARGET_VERSION: "test-version",
  recoverStaleDistillationTargets: mocks.recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets: mocks.releaseRetryablePausedDistillationTargets,
  claimNextDistillationTargetState: mocks.claimNextDistillationTargetState,
  updateDistillationTargetPhase: mocks.updateDistillationTargetPhase,
  updateDistillationTargetHeartbeat: mocks.updateDistillationTargetHeartbeat,
  finishDistillationTargetState: mocks.finishDistillationTargetState,
  pauseDistillationTargetState: mocks.pauseDistillationTargetState,
}));

vi.mock("../src/modules/findCandidate/domain.js", () => ({
  runFindCandidate: mocks.runFindCandidate,
}));

vi.mock("../src/modules/coverEvidence/runner.js", () => ({
  runCoverEvidenceForCandidate: mocks.runCoverEvidenceForCandidate,
}));

vi.mock("../src/modules/finalizeDistille/domain.js", () => ({
  runFinalizeDistille: mocks.runFinalizeDistille,
}));

function targetRow() {
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
  };
}

describe("runDistillationPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshDistillationTargetInventory.mockResolvedValue({});
    mocks.recoverStaleDistillationTargets.mockResolvedValue({});
    mocks.releaseRetryablePausedDistillationTargets.mockResolvedValue({});
    mocks.claimNextDistillationTargetState.mockResolvedValue(targetRow());
    mocks.updateDistillationTargetPhase.mockResolvedValue({});
    mocks.updateDistillationTargetHeartbeat.mockResolvedValue({});
    mocks.finishDistillationTargetState.mockResolvedValue({});
    mocks.pauseDistillationTargetState.mockResolvedValue({});
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
  });

  test("claims a target and finalizes ready candidates", async () => {
    const result = await runDistillationPipeline({ write: true, refresh: false, limit: 1 });

    expect(result.processed).toBe(1);
    expect(result.results[0]).toMatchObject({
      status: "completed",
      outcomeKind: "knowledge_finalized",
      knowledgeIds: ["knowledge-1"],
    });
    expect(mocks.finishDistillationTargetState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "target-1",
        status: "completed",
        outcomeKind: "knowledge_finalized",
        knowledgeIds: ["knowledge-1"],
      }),
    );
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
});
