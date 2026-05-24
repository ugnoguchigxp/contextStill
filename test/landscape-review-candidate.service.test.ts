import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  listLandscapeReviewItemsForCandidateDraftMock,
  upsertLandscapeReviewItemCandidateDraftMock,
  updateLandscapeReviewCandidateLinkStatusMock,
  findLandscapeReviewCandidateLinkByFindCandidateResultIdMock,
  markLandscapeReviewCandidateLinkFinalizedMock,
  markLandscapeReviewCandidateLinkReviewRequiredMock,
} = vi.hoisted(() => ({
  listLandscapeReviewItemsForCandidateDraftMock: vi.fn(),
  upsertLandscapeReviewItemCandidateDraftMock: vi.fn(),
  updateLandscapeReviewCandidateLinkStatusMock: vi.fn(),
  findLandscapeReviewCandidateLinkByFindCandidateResultIdMock: vi.fn(),
  markLandscapeReviewCandidateLinkFinalizedMock: vi.fn(),
  markLandscapeReviewCandidateLinkReviewRequiredMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-review-candidate.repository.js", () => ({
  listLandscapeReviewItemsForCandidateDraft: listLandscapeReviewItemsForCandidateDraftMock,
  upsertLandscapeReviewItemCandidateDraft: upsertLandscapeReviewItemCandidateDraftMock,
  updateLandscapeReviewCandidateLinkStatus: updateLandscapeReviewCandidateLinkStatusMock,
  findLandscapeReviewCandidateLinkByFindCandidateResultId:
    findLandscapeReviewCandidateLinkByFindCandidateResultIdMock,
  markLandscapeReviewCandidateLinkFinalized: markLandscapeReviewCandidateLinkFinalizedMock,
  markLandscapeReviewCandidateLinkReviewRequired:
    markLandscapeReviewCandidateLinkReviewRequiredMock,
  LandscapeReviewCandidateLinkError: class LandscapeReviewCandidateLinkError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.name = "LandscapeReviewCandidateLinkError";
      this.statusCode = statusCode;
    }
  },
}));

import { createLandscapeReviewCandidates } from "../src/modules/landscape/landscape-review-candidate.service.js";

describe("createLandscapeReviewCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("dryRun で deterministic candidate key を返す", async () => {
    listLandscapeReviewItemsForCandidateDraftMock.mockResolvedValue([
      {
        id: "review-item-1",
        source: "replay_compare",
        reason: "baseline_off_topic",
        status: "pending",
        proposedAction: "refine_applies_to",
        priority: 75,
        confidence: "medium",
        idempotencyKey: "idempotency-1",
        knowledgeId: "knowledge-1",
        runId: "run-1",
        triggerEventId: null,
        communityKey: null,
        communityLabel: null,
        suggestedAppliesTo: {
          technologies: [" TypeScript ", "typescript"],
          changeTypes: ["Feature", "feature"],
        },
        evidence: ["B evidence", "A evidence"],
        payload: {},
        note: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        resolvedAt: null,
      },
    ]);

    const first = await createLandscapeReviewCandidates({
      dryRun: true,
      status: "pending",
      limit: 20,
    });
    const second = await createLandscapeReviewCandidates({
      dryRun: true,
      status: "pending",
      limit: 20,
    });

    expect(first.processedCount).toBe(1);
    expect(first.items[0]?.candidateType).toBe("procedure");
    expect(first.items[0]?.candidateKey).toBe(second.items[0]?.candidateKey);
    expect(first.items[0]?.candidateKey).toContain(
      "landscape-review-item:review-item-1:baseline_off_topic:",
    );
    expect(upsertLandscapeReviewItemCandidateDraftMock).not.toHaveBeenCalled();
  });

  test("write mode で upsert 結果を返す", async () => {
    listLandscapeReviewItemsForCandidateDraftMock.mockResolvedValue([
      {
        id: "review-item-2",
        source: "promotion_gate",
        reason: "promotion_gate_review",
        status: "pending",
        proposedAction: "promotion_gate_review",
        priority: 90,
        confidence: "high",
        idempotencyKey: "idempotency-2",
        knowledgeId: null,
        runId: "run-2",
        triggerEventId: null,
        communityKey: null,
        communityLabel: null,
        suggestedAppliesTo: {},
        evidence: ["gate review required"],
        payload: {},
        note: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        resolvedAt: null,
      },
    ]);

    upsertLandscapeReviewItemCandidateDraftMock.mockResolvedValue({
      targetStateId: "target-1",
      findCandidateResultId: "candidate-1",
      created: true,
      link: {
        id: "link-1",
        reviewItemId: "review-item-2",
        targetStateId: "target-1",
        findCandidateResultId: "candidate-1",
        candidateKey: "ck",
        status: "draft_created",
        approvalNote: null,
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    });

    const result = await createLandscapeReviewCandidates({
      dryRun: false,
      status: "pending",
      limit: 20,
    });

    expect(result.createdCount).toBe(1);
    expect(result.existingCount).toBe(0);
    expect(result.items[0]?.targetStateId).toBe("target-1");
    expect(result.items[0]?.draftLinked).toBe(true);
    expect(upsertLandscapeReviewItemCandidateDraftMock).toHaveBeenCalledTimes(1);
  });

  test("ids 指定でも dismissed / contradiction item は draft 対象外", async () => {
    listLandscapeReviewItemsForCandidateDraftMock.mockResolvedValue([
      {
        id: "review-item-keep",
        source: "replay_compare",
        reason: "baseline_off_topic",
        status: "pending",
        proposedAction: "refine_applies_to",
        priority: 75,
        confidence: "medium",
        idempotencyKey: "idempotency-keep",
        knowledgeId: "knowledge-keep",
        runId: "run-1",
        triggerEventId: null,
        communityKey: null,
        communityLabel: null,
        suggestedAppliesTo: {},
        evidence: ["keep"],
        payload: {},
        note: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        resolvedAt: null,
      },
      {
        id: "review-item-dismissed",
        source: "replay_compare",
        reason: "baseline_wrong",
        status: "dismissed",
        proposedAction: "review_wrong",
        priority: 90,
        confidence: "high",
        idempotencyKey: "idempotency-dismissed",
        knowledgeId: "knowledge-dismissed",
        runId: "run-2",
        triggerEventId: null,
        communityKey: null,
        communityLabel: null,
        suggestedAppliesTo: {},
        evidence: ["dismissed"],
        payload: {},
        note: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        resolvedAt: new Date("2026-05-24T00:10:00.000Z"),
      },
      {
        id: "review-item-contradiction",
        source: "contradiction_detection",
        reason: "contradiction_review",
        status: "pending",
        proposedAction: "review_contradiction",
        priority: 80,
        confidence: "medium",
        idempotencyKey: "idempotency-contradiction",
        knowledgeId: "knowledge-contradiction",
        runId: null,
        triggerEventId: null,
        communityKey: null,
        communityLabel: null,
        suggestedAppliesTo: {},
        evidence: ["contradiction"],
        payload: {},
        note: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        resolvedAt: null,
      },
    ]);

    upsertLandscapeReviewItemCandidateDraftMock.mockResolvedValue({
      targetStateId: "target-keep",
      findCandidateResultId: "candidate-keep",
      created: true,
      link: {
        id: "link-keep",
        reviewItemId: "review-item-keep",
        targetStateId: "target-keep",
        findCandidateResultId: "candidate-keep",
        candidateKey: "ck-keep",
        status: "draft_created",
        approvalNote: null,
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    });

    const result = await createLandscapeReviewCandidates({
      dryRun: false,
      status: "pending",
      ids: ["review-item-keep", "review-item-dismissed", "review-item-contradiction"],
      limit: 20,
    });

    expect(result.processedCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.reviewItemId).toBe("review-item-keep");
    expect(result.missingIds).toEqual(["review-item-dismissed", "review-item-contradiction"]);
    expect(upsertLandscapeReviewItemCandidateDraftMock).toHaveBeenCalledTimes(1);
  });
});
