import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  buildLandscapeSnapshotMock,
  buildLandscapeReplaySnapshotMock,
  buildLandscapeReplayComparisonMock,
  buildLandscapeContradictionCandidatesMock,
  countLandscapeReviewItemRowsMock,
  findLandscapeReviewItemRowByIdMock,
  insertLandscapeReviewItemsIdempotentMock,
  listLandscapeReviewItemRowsMock,
  recordAuditLogSafeMock,
  updateLandscapeReviewItemRowMock,
} = vi.hoisted(() => ({
  buildLandscapeSnapshotMock: vi.fn(),
  buildLandscapeReplaySnapshotMock: vi.fn(),
  buildLandscapeReplayComparisonMock: vi.fn(),
  buildLandscapeContradictionCandidatesMock: vi.fn(),
  countLandscapeReviewItemRowsMock: vi.fn(),
  findLandscapeReviewItemRowByIdMock: vi.fn(),
  insertLandscapeReviewItemsIdempotentMock: vi.fn(),
  listLandscapeReviewItemRowsMock: vi.fn(),
  recordAuditLogSafeMock: vi.fn(),
  updateLandscapeReviewItemRowMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: buildLandscapeReplayComparisonMock,
}));

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: buildLandscapeSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-replay.service.js", () => ({
  buildLandscapeReplaySnapshot: buildLandscapeReplaySnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-contradiction.service.js", () => ({
  buildLandscapeContradictionCandidates: buildLandscapeContradictionCandidatesMock,
}));

vi.mock("../src/modules/landscape/landscape-review-items.repository.js", () => ({
  countLandscapeReviewItemRows: countLandscapeReviewItemRowsMock,
  insertLandscapeReviewItemsIdempotent: insertLandscapeReviewItemsIdempotentMock,
  listLandscapeReviewItemRows: listLandscapeReviewItemRowsMock,
  findLandscapeReviewItemRowById: findLandscapeReviewItemRowByIdMock,
  updateLandscapeReviewItemRow: updateLandscapeReviewItemRowMock,
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    landscapeReviewItemsMaterialized: "LANDSCAPE_REVIEW_ITEMS_MATERIALIZED",
    landscapeReviewItemStatusChanged: "LANDSCAPE_REVIEW_ITEM_STATUS_CHANGED",
  },
  recordAuditLogSafe: recordAuditLogSafeMock,
}));

import {
  LandscapeReviewItemsError,
  buildLandscapeReviewItemCandidates,
  listLandscapeContradictionOverlay,
  listLandscapeReviewItems,
  materializeLandscapeReviewItems,
  updateLandscapeReviewItemStatus,
} from "../src/modules/landscape/landscape-review-items.service.js";
import {
  landscapeReplaySnapshotFixture,
  landscapeSnapshotFixture,
  replayComparisonFixture,
  replayComparisonForPromotionGate,
  reviewItemRowFixture,
} from "./fixtures/landscape-review-items-fixtures.ts";
import type { LandscapeSnapshot } from "../src/modules/landscape/landscape.types.js";

describe("landscape review items service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeReplayComparisonMock.mockResolvedValue(replayComparisonFixture());
    buildLandscapeSnapshotMock.mockResolvedValue(landscapeSnapshotFixture());
    buildLandscapeReplaySnapshotMock.mockResolvedValue(landscapeReplaySnapshotFixture());
    buildLandscapeContradictionCandidatesMock.mockResolvedValue([]);
    insertLandscapeReviewItemsIdempotentMock.mockResolvedValue({
      inserted: [],
      existing: [],
    });
    countLandscapeReviewItemRowsMock.mockResolvedValue(0);
    listLandscapeReviewItemRowsMock.mockResolvedValue([]);
    findLandscapeReviewItemRowByIdMock.mockResolvedValue(null);
    updateLandscapeReviewItemRowMock.mockResolvedValue(null);
  });

  test("builds replay-compare candidates with idempotency key", async () => {
    const result = await buildLandscapeReviewItemCandidates({
      generatedAt: "2026-05-24T00:00:00.000Z",
      runStatus: "all",
      sources: ["replay_compare"],
      appliesToRefineCandidates: replayComparisonFixture().appliesToRefineCandidates,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        source: "replay_compare",
        reason: "baseline_wrong",
        proposedAction: "review_wrong",
        priority: 95,
        idempotencyKey: "replay_compare:baseline_wrong:run-1:knowledge-1",
      }),
    );
  });

  test("dry-run does not write DB", async () => {
    const result = await materializeLandscapeReviewItems({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["replay_compare"],
      materializeLimit: 50,
    });

    expect(insertLandscapeReviewItemsIdempotentMock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.insertedCount).toBe(0);
  });

  test("rejects unsupported sources in current phase materialize", async () => {
    const unsupportedSource = "unsupported_source" as unknown as "replay_compare";

    await expect(
      materializeLandscapeReviewItems({
        dryRun: true,
        windowDays: 30,
        limit: 100,
        runStatus: "all",
        currentLimit: 12,
        landscapeLimit: 1000,
        landscapeStatus: "active",
        relationAxes: ["session", "project", "source"],
        minSelectedCount: 3,
        minFeedbackCount: 3,
        minSimilarity: 0.72,
        semanticTopK: 3,
        sources: [unsupportedSource],
        materializeLimit: 50,
      }),
    ).rejects.toMatchObject({
      name: "LandscapeReviewItemsError",
      statusCode: 400,
    });
    expect(buildLandscapeReplayComparisonMock).not.toHaveBeenCalled();
    expect(insertLandscapeReviewItemsIdempotentMock).not.toHaveBeenCalled();
  });

  test("builds landscape-snapshot candidates from risks", async () => {
    const result = await buildLandscapeReviewItemCandidates({
      generatedAt: "2026-05-24T00:00:00.000Z",
      runStatus: "all",
      sources: ["landscape_snapshot"],
      appliesToRefineCandidates: [],
      landscapeSnapshot: landscapeSnapshotFixture() as LandscapeSnapshot,
    });
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        source: "landscape_snapshot",
        reason: "negative_attractor_candidate",
        proposedAction: "refine_applies_to",
        priority: 85,
        confidence: "high",
        communityLabel: "Auth Boundary",
      }),
    );
  });

  test("materializes landscape_snapshot without replay-compare call", async () => {
    const result = await materializeLandscapeReviewItems({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["landscape_snapshot"],
      materializeLimit: 50,
    });

    expect(result.candidateCount).toBe(1);
    expect(buildLandscapeSnapshotMock).toHaveBeenCalled();
    expect(buildLandscapeReplayComparisonMock).not.toHaveBeenCalled();
  });

  test("builds semantic-relation candidates from community comparison", async () => {
    const result = await buildLandscapeReviewItemCandidates({
      generatedAt: "2026-05-24T00:00:00.000Z",
      runStatus: "all",
      sources: ["semantic_relation_comparison"],
      appliesToRefineCandidates: [],
      landscapeReplaySnapshot: landscapeReplaySnapshotFixture(),
    });
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        source: "semantic_relation_comparison",
        reason: "semantic_split",
        proposedAction: "split_or_merge_review",
        priority: 55,
        confidence: "medium",
        communityLabel: "User Session",
      }),
    );
  });

  test("materializes semantic relation source without replay-compare call", async () => {
    const result = await materializeLandscapeReviewItems({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["semantic_relation_comparison"],
      materializeLimit: 50,
    });

    expect(result.candidateCount).toBe(1);
    expect(buildLandscapeReplaySnapshotMock).toHaveBeenCalled();
    expect(buildLandscapeReplayComparisonMock).not.toHaveBeenCalled();
    expect(buildLandscapeSnapshotMock).not.toHaveBeenCalled();
  });

  test("builds promotion-gate candidates when gate review is required", async () => {
    const result = await buildLandscapeReviewItemCandidates({
      generatedAt: "2026-05-24T00:00:00.000Z",
      runStatus: "all",
      sources: ["promotion_gate"],
      appliesToRefineCandidates: [],
      landscapeReplayComparison: replayComparisonForPromotionGate("review_required"),
    });
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        source: "promotion_gate",
        reason: "promotion_gate_review",
        proposedAction: "promotion_gate_review",
        priority: 90,
      }),
    );
  });

  test("does not build promotion-gate candidates in normal mode", async () => {
    const result = await buildLandscapeReviewItemCandidates({
      generatedAt: "2026-05-24T00:00:00.000Z",
      runStatus: "all",
      sources: ["promotion_gate"],
      appliesToRefineCandidates: [],
      landscapeReplayComparison: replayComparisonForPromotionGate("normal"),
    });
    expect(result.candidateCount).toBe(0);
  });

  test("materializes promotion_gate without replay-snapshot and snapshot calls", async () => {
    buildLandscapeReplayComparisonMock.mockResolvedValueOnce(
      replayComparisonForPromotionGate("review_required"),
    );

    const result = await materializeLandscapeReviewItems({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["promotion_gate"],
      materializeLimit: 50,
    });

    expect(result.candidateCount).toBe(1);
    expect(buildLandscapeReplayComparisonMock).toHaveBeenCalled();
    expect(buildLandscapeReplaySnapshotMock).not.toHaveBeenCalled();
    expect(buildLandscapeSnapshotMock).not.toHaveBeenCalled();
  });

  test("materializes contradiction_detection without replay/snapshot calls", async () => {
    buildLandscapeContradictionCandidatesMock.mockResolvedValueOnce([
      {
        pairKey: "sha1:pair-1",
        leftKnowledgeId: "knowledge-left",
        rightKnowledgeId: "knowledge-right",
        confidence: 0.79,
        confidenceLabel: "medium",
        priority: 78,
        relationNeighbor: true,
        semanticNeighbor: false,
        scopeOverlap: {
          repoPath: true,
          repoKey: true,
          technologies: ["typescript"],
          changeTypes: ["implementation"],
          domains: ["graph-ui"],
        },
        sharedConceptTokens: ["timeout", "retry"],
        leftMarkers: ["must"],
        rightMarkers: ["avoid"],
        leftSnippet: "left snippet",
        rightSnippet: "right snippet",
        communityKey: "a".repeat(64),
        communityLabel: "Core Reliability",
        evidence: ["pair evidence"],
        payload: {
          generatedBy: "landscape_contradiction_detection",
        },
      },
    ]);

    const result = await materializeLandscapeReviewItems({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["contradiction_detection"],
      materializeLimit: 50,
    });

    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        source: "contradiction_detection",
        reason: "contradiction_review",
        proposedAction: "review_contradiction",
        knowledgeId: "knowledge-left",
      }),
    );
    expect(buildLandscapeContradictionCandidatesMock).toHaveBeenCalled();
    expect(buildLandscapeReplayComparisonMock).not.toHaveBeenCalled();
    expect(buildLandscapeReplaySnapshotMock).not.toHaveBeenCalled();
    expect(buildLandscapeSnapshotMock).not.toHaveBeenCalled();
  });

  test("deduplicates candidates by idempotency key before materialize", async () => {
    buildLandscapeReplayComparisonMock.mockResolvedValueOnce({
      appliesToRefineCandidates: [
        replayComparisonFixture().appliesToRefineCandidates[0],
        replayComparisonFixture().appliesToRefineCandidates[0],
      ],
    });

    const result = await materializeLandscapeReviewItems({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["replay_compare"],
      materializeLimit: 50,
    });

    expect(result.candidateCount).toBe(1);
    expect(result.candidates).toHaveLength(1);
  });

  test("write path reports existing items from idempotent insert", async () => {
    insertLandscapeReviewItemsIdempotentMock.mockResolvedValueOnce({
      inserted: [],
      existing: [
        {
          id: "review-item-1",
          source: "replay_compare",
          reason: "baseline_wrong",
          status: "pending",
          proposedAction: "review_wrong",
          priority: 95,
          confidence: "medium",
          idempotencyKey: "replay_compare:baseline_wrong:run-1:knowledge-1",
          knowledgeId: "knowledge-1",
          runId: "run-1",
          triggerEventId: null,
          communityKey: null,
          communityLabel: null,
          suggestedAppliesTo: {
            retrievalMode: "task_context",
          },
          evidence: ["wrong baseline"],
          payload: {
            generatedBy: "landscape_replay_compare",
          },
          note: null,
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          updatedAt: new Date("2026-05-24T00:00:00.000Z"),
          resolvedAt: null,
        },
      ],
    });

    const result = await materializeLandscapeReviewItems({
      dryRun: false,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["replay_compare"],
      materializeLimit: 50,
    });

    expect(result.insertedCount).toBe(0);
    expect(result.existingCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(recordAuditLogSafeMock).toHaveBeenCalled();
  });

  test("status transition guard rejects resolved -> pending", async () => {
    findLandscapeReviewItemRowByIdMock.mockResolvedValueOnce(
      reviewItemRowFixture({
        status: "resolved",
        resolvedAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
    );

    await expect(
      updateLandscapeReviewItemStatus({
        id: "review-item-1",
        status: "pending",
      }),
    ).rejects.toBeInstanceOf(LandscapeReviewItemsError);
    expect(updateLandscapeReviewItemRowMock).not.toHaveBeenCalled();
  });

  test("same status update is no-op and does not write DB", async () => {
    findLandscapeReviewItemRowByIdMock.mockResolvedValueOnce(
      reviewItemRowFixture({ status: "reviewing" }),
    );

    const item = await updateLandscapeReviewItemStatus({
      id: "review-item-1",
      status: "reviewing",
      note: "keep current state",
    });

    expect(item).toEqual(expect.objectContaining({ id: "review-item-1", status: "reviewing" }));
    expect(updateLandscapeReviewItemRowMock).not.toHaveBeenCalled();
    expect(recordAuditLogSafeMock).not.toHaveBeenCalled();
  });

  test("list returns total count independent from page limit", async () => {
    listLandscapeReviewItemRowsMock.mockResolvedValueOnce([reviewItemRowFixture()]);
    countLandscapeReviewItemRowsMock.mockResolvedValueOnce(3);

    const result = await listLandscapeReviewItems({
      status: "pending",
      source: "all",
      reason: "all",
      proposedAction: "all",
      priorityMin: 0,
      limit: 1,
    });

    expect(result.items).toHaveLength(1);
    expect(result.count).toBe(3);
  });

  test("contradiction overlay excludes low confidence by threshold", async () => {
    listLandscapeReviewItemRowsMock.mockResolvedValueOnce([
      reviewItemRowFixture({
        id: "review-item-ctr-1",
        source: "contradiction_detection",
        reason: "contradiction_review",
        confidence: "low",
        knowledgeId: "knowledge-left",
        payload: {
          rightKnowledgeId: "knowledge-right",
          confidence: 0.55,
          pairKey: "knowledge-left::knowledge-right",
        },
      }),
      reviewItemRowFixture({
        id: "review-item-ctr-2",
        source: "contradiction_detection",
        reason: "contradiction_review",
        confidence: "high",
        knowledgeId: "knowledge-left-2",
        payload: {
          rightKnowledgeId: "knowledge-right-2",
          confidence: 0.84,
          pairKey: "knowledge-left-2::knowledge-right-2",
        },
      }),
    ]);
    countLandscapeReviewItemRowsMock.mockResolvedValueOnce(2);

    const overlay = await listLandscapeContradictionOverlay({
      status: "pending",
      confidenceMin: 0.62,
      limit: 20,
    });

    expect(overlay.count).toBe(1);
    expect(overlay.items[0]).toEqual(
      expect.objectContaining({
        reviewItemId: "review-item-ctr-2",
        pairKey: "knowledge-left-2::knowledge-right-2",
      }),
    );
  });
});
