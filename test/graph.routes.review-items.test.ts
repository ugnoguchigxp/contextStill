import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  validLandscapeSnapshot,
  validLandscapeSnapshotCacheStatus,
  validReplayComparison,
  validReplaySnapshot,
  validTrajectory,
} from "./fixtures/graph-route-fixtures.js";

const {
  buildLandscapeReplayComparisonMock,
  buildLandscapeReplaySnapshotMock,
  buildLandscapeSnapshotMock,
  getLandscapeSnapshotCacheStatusMock,
  buildLandscapeTrajectoryMock,
  createLandscapeReviewCandidatesMock,
  updateLandscapeReviewCandidateLinkMock,
  listLandscapeReviewItemsMock,
  listLandscapeContradictionOverlayMock,
  materializeLandscapeReviewItemsMock,
  updateLandscapeReviewItemStatusMock,
  LandscapeReviewCandidateLinkErrorMock,
  LandscapeReviewItemsErrorMock,
} = vi.hoisted(() => ({
  buildLandscapeReplayComparisonMock: vi.fn(),
  buildLandscapeReplaySnapshotMock: vi.fn(),
  buildLandscapeSnapshotMock: vi.fn(),
  getLandscapeSnapshotCacheStatusMock: vi.fn(),
  buildLandscapeTrajectoryMock: vi.fn(),
  createLandscapeReviewCandidatesMock: vi.fn(),
  updateLandscapeReviewCandidateLinkMock: vi.fn(),
  listLandscapeReviewItemsMock: vi.fn(),
  listLandscapeContradictionOverlayMock: vi.fn(),
  materializeLandscapeReviewItemsMock: vi.fn(),
  updateLandscapeReviewItemStatusMock: vi.fn(),
  LandscapeReviewCandidateLinkErrorMock: class LandscapeReviewCandidateLinkErrorMock extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.name = "LandscapeReviewCandidateLinkError";
      this.statusCode = statusCode;
    }
  },
  LandscapeReviewItemsErrorMock: class LandscapeReviewItemsErrorMock extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.name = "LandscapeReviewItemsError";
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: buildLandscapeReplayComparisonMock,
}));

vi.mock("../src/modules/landscape/landscape-replay.service.js", () => ({
  buildLandscapeReplaySnapshot: buildLandscapeReplaySnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: buildLandscapeSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-snapshot-cache.service.js", () => ({
  getLandscapeSnapshotCacheStatus: getLandscapeSnapshotCacheStatusMock,
}));

vi.mock("../src/modules/landscape/landscape-trajectory.service.js", () => ({
  buildLandscapeTrajectory: buildLandscapeTrajectoryMock,
}));

vi.mock("../src/modules/landscape/landscape-review-items.service.js", () => ({
  listLandscapeReviewItems: listLandscapeReviewItemsMock,
  listLandscapeContradictionOverlay: listLandscapeContradictionOverlayMock,
  materializeLandscapeReviewItems: materializeLandscapeReviewItemsMock,
  updateLandscapeReviewItemStatus: updateLandscapeReviewItemStatusMock,
  LandscapeReviewItemsError: LandscapeReviewItemsErrorMock,
}));

vi.mock("../src/modules/landscape/landscape-review-candidate.service.js", () => ({
  createLandscapeReviewCandidates: createLandscapeReviewCandidatesMock,
  updateLandscapeReviewCandidateLink: updateLandscapeReviewCandidateLinkMock,
  LandscapeReviewCandidateLinkError: LandscapeReviewCandidateLinkErrorMock,
}));

vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: vi.fn(),
  fetchGraphNodeDetail: vi.fn(),
  listGraphCommunityLabels: vi.fn(),
  upsertGraphCommunityLabel: vi.fn(),
}));

import { graphRouter } from "../api/modules/graph/graph.routes.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/graph", graphRouter);
  return app;
}

describe("graph routes landscape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeSnapshotMock.mockResolvedValue(validLandscapeSnapshot());
    getLandscapeSnapshotCacheStatusMock.mockResolvedValue(validLandscapeSnapshotCacheStatus());
    buildLandscapeReplaySnapshotMock.mockResolvedValue(validReplaySnapshot());
    buildLandscapeReplayComparisonMock.mockResolvedValue(validReplayComparison());
    buildLandscapeTrajectoryMock.mockResolvedValue(validTrajectory());
    materializeLandscapeReviewItemsMock.mockResolvedValue({
      dryRun: true,
      generatedAt: "2026-05-24T00:00:00.000Z",
      candidateCount: 1,
      insertedCount: 0,
      existingCount: 0,
      skippedCount: 0,
      items: [],
      candidates: [
        {
          source: "replay_compare",
          reason: "baseline_wrong",
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
        },
      ],
    });
    createLandscapeReviewCandidatesMock.mockResolvedValue({
      dryRun: true,
      processedCount: 1,
      createdCount: 0,
      existingCount: 0,
      missingIds: [],
      items: [
        {
          reviewItemId: "review-item-1",
          reason: "baseline_wrong",
          proposedAction: "review_wrong",
          candidateType: "rule",
          candidateKey: "landscape-review-item:review-item-1:baseline_wrong:abc",
          targetKey: "landscape-review-item:review-item-1:baseline_wrong:abc",
          targetStateId: null,
          findCandidateResultId: null,
          linkId: null,
          linkStatus: null,
          draftLinked: false,
        },
      ],
    });
    updateLandscapeReviewCandidateLinkMock.mockResolvedValue({
      link: {
        id: "link-1",
        reviewItemId: "review-item-1",
        targetStateId: "target-1",
        findCandidateResultId: "candidate-1",
        candidateKey: "landscape-review-item:review-item-1:baseline_wrong:abc",
        status: "approved",
        approvalNote: "approved manually",
        approvedBy: "reviewer",
        approvedAt: "2026-05-24T00:20:00.000Z",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:20:00.000Z",
      },
    });
    listLandscapeReviewItemsMock.mockResolvedValue({
      count: 1,
      items: [
        {
          id: "review-item-1",
          source: "replay_compare",
          reason: "baseline_wrong",
          status: "pending",
          proposedAction: "review_wrong",
          priority: 95,
          confidence: "medium",
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
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    listLandscapeContradictionOverlayMock.mockResolvedValue({
      count: 1,
      items: [
        {
          reviewItemId: "review-item-3",
          leftKnowledgeId: "knowledge-1",
          rightKnowledgeId: "knowledge-2",
          pairKey: "knowledge-1::knowledge-2",
          confidence: 0.74,
          confidenceLabel: "medium",
          status: "pending",
          evidence: ["pair=knowledge-1::knowledge-2"],
          communityKey: "a".repeat(64),
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      ],
    });
    updateLandscapeReviewItemStatusMock.mockResolvedValue({
      id: "review-item-1",
      source: "replay_compare",
      reason: "baseline_wrong",
      status: "resolved",
      proposedAction: "review_wrong",
      priority: 95,
      confidence: "medium",
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
      note: "manually reviewed",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:10:00.000Z",
      resolvedAt: "2026-05-24T00:10:00.000Z",
    });
  });

  test("GET /api/graph/landscape/review-items parses filters", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/review-items?status=pending&source=replay_compare&reason=baseline_wrong&proposedAction=review_wrong&knowledgeId=knowledge-1&runId=run-1&communityKey=community-a&priorityMin=70&limit=20",
    );
    expect(response.status).toBe(200);
    expect(listLandscapeReviewItemsMock).toHaveBeenCalledWith({
      status: "pending",
      source: "replay_compare",
      reason: "baseline_wrong",
      proposedAction: "review_wrong",
      knowledgeId: "knowledge-1",
      runId: "run-1",
      communityKey: "community-a",
      priorityMin: 70,
      limit: 20,
    });
  });

  test("GET /api/graph/landscape/contradictions parses filters", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/contradictions?status=reviewing&confidenceMin=0.72&limit=25",
    );
    expect(response.status).toBe(200);
    expect(listLandscapeContradictionOverlayMock).toHaveBeenCalledWith({
      status: "reviewing",
      confidenceMin: 0.72,
      limit: 25,
    });
  });

  test("PATCH /api/graph/landscape/review-items/:id updates status", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/review-items/review-item-1", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "resolved",
        note: "manually reviewed",
      }),
    });
    expect(response.status).toBe(200);
    expect(updateLandscapeReviewItemStatusMock).toHaveBeenCalledWith({
      id: "review-item-1",
      status: "resolved",
      note: "manually reviewed",
    });
  });

  test("PATCH /api/graph/landscape/review-items/:id returns 409 on invalid transition", async () => {
    const app = buildApp();
    updateLandscapeReviewItemStatusMock.mockRejectedValueOnce(
      new LandscapeReviewItemsErrorMock(409, "invalid status transition: resolved -> pending"),
    );
    const response = await app.request("/api/graph/landscape/review-items/review-item-1", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "pending",
      }),
    });
    expect(response.status).toBe(409);
  });
});
