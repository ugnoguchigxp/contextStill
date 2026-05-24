import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  buildLandscapeReplayComparisonMock,
  findLandscapeReviewItemRowByIdMock,
  insertLandscapeReviewItemsIdempotentMock,
  listLandscapeReviewItemRowsMock,
  recordAuditLogSafeMock,
  updateLandscapeReviewItemRowMock,
} = vi.hoisted(() => ({
  buildLandscapeReplayComparisonMock: vi.fn(),
  findLandscapeReviewItemRowByIdMock: vi.fn(),
  insertLandscapeReviewItemsIdempotentMock: vi.fn(),
  listLandscapeReviewItemRowsMock: vi.fn(),
  recordAuditLogSafeMock: vi.fn(),
  updateLandscapeReviewItemRowMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: buildLandscapeReplayComparisonMock,
}));

vi.mock("../src/modules/landscape/landscape-review-items.repository.js", () => ({
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
  materializeLandscapeReviewItems,
  updateLandscapeReviewItemStatus,
} from "../src/modules/landscape/landscape-review-items.service.js";
import type { LandscapeAppliesToRefineCandidate } from "../src/modules/landscape/landscape-replay.types.js";

function replayComparisonFixture(): {
  appliesToRefineCandidates: LandscapeAppliesToRefineCandidate[];
} {
  return {
    appliesToRefineCandidates: [
      {
        runId: "run-1",
        knowledgeId: "knowledge-1",
        reason: "baseline_wrong",
        confidence: "medium",
        suggestedAppliesTo: {
          retrievalMode: "task_context",
          technologies: ["typescript"],
          changeTypes: ["feature"],
          domains: ["graph-ui"],
        },
        evidence: ["wrong baseline"],
      },
    ],
  };
}

function reviewItemRowFixture(overrides: Record<string, unknown> = {}) {
  return {
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
    suggestedAppliesTo: {},
    evidence: [],
    payload: {},
    note: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    resolvedAt: null,
    ...overrides,
  };
}

describe("landscape review items service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeReplayComparisonMock.mockResolvedValue(replayComparisonFixture());
    insertLandscapeReviewItemsIdempotentMock.mockResolvedValue({
      inserted: [],
      existing: [],
    });
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

  test("rejects unsupported sources in AQ-1A materialize", async () => {
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
        sources: ["landscape_snapshot"],
        materializeLimit: 50,
      }),
    ).rejects.toMatchObject({
      name: "LandscapeReviewItemsError",
      statusCode: 400,
    });
    expect(buildLandscapeReplayComparisonMock).not.toHaveBeenCalled();
    expect(insertLandscapeReviewItemsIdempotentMock).not.toHaveBeenCalled();
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
});
