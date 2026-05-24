import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  landscapeReplayComparisonResponseSchema,
  landscapeReplaySnapshotSchema,
} from "../src/shared/schemas/landscape-replay.schema.js";
import { landscapeSnapshotCacheStatusSchema } from "../src/shared/schemas/landscape-snapshot-cache.schema.js";
import { landscapeSnapshotSchema } from "../src/shared/schemas/landscape.schema.js";
import { landscapeTrajectoryResultSchema } from "../src/shared/schemas/landscape-trajectory.schema.js";

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

function validLandscapeSnapshot() {
  return landscapeSnapshotSchema.parse({
    generatedAt: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    basis: {
      unit: "community",
      relationAxes: ["session", "project", "source"],
      status: "active",
    },
    thresholds: {
      minSelectedCount: 3,
      minFeedbackCount: 3,
      feedbackConfidence: { mediumMin: 10, highMin: 30 },
      feedbackFactor: { insufficient: 0.4, low: 0.7, medium: 0.9, high: 1 },
      attractor: {
        strongUsedRateMin: 0.7,
        usefulUsedRateMin: 0.5,
        strongSourceRefDensityMin: 0.6,
      },
      negative: {
        offTopicWeight: 1,
        wrongWeight: 3,
        candidateOffTopicRateMin: 0.4,
      },
      notUsed: {
        overSelectedRateMin: 0.6,
      },
      deadZone: {
        reachabilityRiskMin: 0.3,
        staleSourceRefDensityMax: 0.5,
        staleFactorMin: 0.5,
      },
      evidenceFactor: {
        sourceRefDensityBaseline: 1,
        min: 0.25,
        max: 1.25,
      },
    },
    stats: {
      totalCommunities: 1,
      activeCommunities: 1,
      selectedCommunities: 1,
      insufficientFeedbackCommunities: 0,
      strongAttractorCount: 1,
      usefulAttractorCount: 0,
      negativeCandidateCount: 0,
      overSelectedNotUsedCount: 0,
      deadZoneReachabilityCount: 0,
      deadZoneStaleCount: 0,
    },
    communities: [
      {
        communityId: "community:1",
        communityKey: "a".repeat(64),
        communityLabel: "Core",
        communityRank: 1,
        size: 2,
        memberCounts: {
          active: 2,
          draft: 0,
          deprecated: 0,
          rule: 1,
          procedure: 1,
          embedded: 2,
        },
        selection: {
          selectedItemCountWindow: 10,
          selectedRunCountWindow: 8,
          cumulativeCompileSelectCount: 20,
          zeroUseActiveCount: 0,
          zeroUseActiveRatio: 0,
        },
        feedback: {
          usedCountWindow: 7,
          notUsedCountWindow: 2,
          offTopicCountWindow: 1,
          wrongCountWindow: 0,
          feedbackCountWindow: 10,
          usedRate: 0.7,
          notUsedRate: 0.2,
          offTopicRate: 0.1,
          wrongRate: 0,
          feedbackConfidence: "medium",
        },
        quality: {
          avgImportance: 80,
          avgConfidence: 82,
          avgDynamicScore: 25,
          sourceRefCount: 4,
          sourceRefDensity: 2,
          avgFreshnessFactor: 0.9,
          avgStalenessFactor: 0.1,
        },
        scores: {
          activity: 10,
          attractorScore: 5.67,
          negativeScore: 0.9,
          reachabilityRiskScore: 0.1,
        },
        classification: {
          primary: "strong_attractor",
          flags: [],
          confidence: "medium",
          reason: "used rate is high",
        },
        recommendedActions: ["keep it"],
        representativeKnowledgeIds: ["k1", "k2"],
      },
    ],
    risks: [],
  });
}

function validReplaySnapshot() {
  return landscapeReplaySnapshotSchema.parse({
    generatedAt: "2026-05-24T00:00:00.000Z",
    analysisAsOf: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    corpusWindow: {
      startAt: "2026-04-24T00:00:00.000Z",
      endAt: "2026-05-24T00:00:00.000Z",
    },
    landscapeWindow: {
      days: 30,
      analysisAsOf: "2026-05-24T00:00:00.000Z",
    },
    basis: {
      unit: "community-replay",
      relationAxes: ["session", "project", "source"],
      runStatus: "all",
      landscapeStatus: "active",
      minSimilarity: 0.72,
      semanticTopK: 3,
    },
    replayRunCount: 0,
    selectedKnowledgeCount: 0,
    missingKnowledgeCount: 0,
    runs: [],
    facetSummaries: [],
    communityReplaySummaries: [],
    acceptanceWindow: {
      eventCountWindow: 0,
      acceptedCountWindow: 0,
      acceptedRunCountWindow: 0,
      unknownAcceptanceCountWindow: 0,
      agentActorEventCountWindow: 0,
      acceptanceRateKnownWindow: 0,
      acceptanceCoverageRate: 0,
    },
    communityComparison: {
      universeKnowledgeCount: 0,
      comparedKnowledgeCount: 0,
      missingRelationAssignmentCount: 0,
      missingSemanticAssignmentCount: 0,
      alignedCount: 0,
      semanticSplitCount: 0,
      semanticMergeCount: 0,
      relationOrphanCount: 0,
      semanticReachableDeadZoneCount: 0,
      communities: [],
    },
  });
}

function validLandscapeSnapshotCacheStatus() {
  return landscapeSnapshotCacheStatusSchema.parse({
    generatedAt: "2026-05-24T00:00:00.000Z",
    enabled: true,
    ttlSeconds: 300,
    disabledReason: null,
    snapshots: [
      {
        snapshotType: "landscape_snapshot",
        readyCount: 2,
        staleCount: 1,
        expiredReadyCount: 1,
        oldestGeneratedAt: "2026-05-23T22:00:00.000Z",
        latestGeneratedAt: "2026-05-24T00:00:00.000Z",
        latestExpiresAt: "2026-05-24T00:05:00.000Z",
        estimatedPayloadBytes: 2048,
        lastPurge: null,
      },
      {
        snapshotType: "landscape_replay_snapshot",
        readyCount: 1,
        staleCount: 0,
        expiredReadyCount: 0,
        oldestGeneratedAt: "2026-05-23T22:30:00.000Z",
        latestGeneratedAt: "2026-05-24T00:00:00.000Z",
        latestExpiresAt: "2026-05-24T00:05:00.000Z",
        estimatedPayloadBytes: 1024,
        lastPurge: {
          purgedAt: "2026-05-23T23:55:00.000Z",
          staleDeletedCount: 1,
          expiredDeletedCount: 0,
          deletedCount: 1,
          snapshotTypes: ["landscape_replay_snapshot"],
          error: null,
        },
      },
      {
        snapshotType: "landscape_replay_comparison",
        readyCount: 0,
        staleCount: 0,
        expiredReadyCount: 0,
        oldestGeneratedAt: null,
        latestGeneratedAt: null,
        latestExpiresAt: null,
        estimatedPayloadBytes: 0,
        lastPurge: null,
      },
    ],
  });
}

function validReplayComparison() {
  return landscapeReplayComparisonResponseSchema.parse({
    generatedAt: "2026-05-24T00:00:00.000Z",
    analysisAsOf: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    corpusWindow: {
      startAt: "2026-04-24T00:00:00.000Z",
      endAt: "2026-05-24T00:00:00.000Z",
    },
    basis: {
      unit: "replay-comparison",
      mode: "current_retrieval",
      runStatus: "all",
      currentLimit: 12,
    },
    replayRunCount: 0,
    comparedRunCount: 0,
    baselineSelectedItemCount: 0,
    currentRetrievedItemCount: 0,
    retainedItemCount: 0,
    missingFromCurrentItemCount: 0,
    newlyRetrievedItemCount: 0,
    usedBaselineLostItemCount: 0,
    averageOverlapRate: 0,
    currentNoMatchRunCount: 0,
    comparisonCounts: {
      stable: 0,
      drifted: 0,
      lost_baseline: 0,
      new_only: 0,
      no_current_match: 0,
    },
    recompilePlan: {
      mode: "current_retrieval_dry_run",
      writesCompileRuns: false,
      replayRunCount: 0,
      comparedRunCount: 0,
      blockers: [],
    },
    rankingExperiments: [
      {
        experiment: "current_retrieval",
        productionEnabled: false,
        targetRunCount: 0,
        estimatedRetainedItemCount: 0,
        estimatedMissingFromCurrentItemCount: 0,
        estimatedUsedBaselineLostItemCount: 0,
        estimatedAverageOverlapRate: 0,
        riskReductionSignal: 0,
        recommendation: "observe",
      },
    ],
    appliesToRefineCandidates: [],
    promotionGateSummary: {
      productionEnabled: false,
      gateMode: "normal",
      shouldTighten: false,
      affectedRunCount: 0,
      riskyNewKnowledgeCount: 0,
      reason: "none",
    },
    scoreTuning: {
      productionEnabled: false,
      stableRunCount: 0,
      driftedRunCount: 0,
      lostBaselineRunCount: 0,
      negativeFeedbackRunCount: 0,
      highChurnRunCount: 0,
      lostUsedBaselineRunCount: 0,
      noCurrentMatchRunCount: 0,
      averageReplacementRate: 0,
      recommendations: [],
    },
    compileInterventionPlan: {
      productionEnabled: false,
      strategy: "observe_only",
      candidateRunCount: 0,
      reason: "none",
    },
    runs: [],
  });
}

function validTrajectory() {
  return landscapeTrajectoryResultSchema.parse({
    run: {
      id: "run-1",
      goal: "inspect trajectory",
      retrievalMode: "task_context",
      status: "ok",
      source: "mcp",
      createdAt: "2026-05-24T00:00:00.000Z",
    },
    traceAvailable: true,
    warnings: [],
    stageCounts: {
      totalCandidates: 2,
      textHit: 1,
      vectorHit: 1,
      merged: 2,
      finalRanked: 1,
      selected: 1,
      suppressed: 1,
    },
    selectedKnowledgeIds: ["knowledge-1"],
    diagnostics: {
      candidateTraceSavedCount: 2,
      candidateTraceTruncated: false,
      candidateTraceLimit: 200,
      candidateTraceSkippedReason: null,
    },
    candidates: [
      {
        itemKind: "rule",
        itemId: "knowledge-1",
        textRank: 1,
        textScore: 0.9,
        vectorRank: null,
        vectorScore: null,
        mergedRank: 1,
        mergedScore: 0.9,
        finalRank: 1,
        finalScore: 0.9,
        selected: true,
        suppressed: false,
        suppressionReason: null,
        agenticDecision: "accepted",
        rankingReason: "selected",
        communityKey: null,
        evidence: {
          status: "selected",
          candidateEvidence: {
            textMatched: true,
            vectorMatched: false,
            vectorScore: null,
            facetMatched: true,
          },
        },
      },
    ],
    communitySummary: [],
    taskTrace: null,
    taskSimilarity: [],
  });
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

  test("GET /api/graph/landscape applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeSnapshotSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeSnapshotMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 1000,
      status: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
    });
  });

  test("GET /api/graph/landscape parses custom query", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape?windowDays=14&limit=120&status=all&relationAxes=project,source&minSelectedCount=5&minFeedbackCount=7&format=full",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeSnapshotMock).toHaveBeenCalledWith({
      windowDays: 14,
      limit: 120,
      status: "all",
      relationAxes: ["project", "source"],
      minSelectedCount: 5,
      minFeedbackCount: 7,
    });
  });

  test("GET /api/graph/landscape/replay applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeReplaySnapshotSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeReplaySnapshotMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 500,
      landscapeLimit: 1000,
      runStatus: "all",
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      includeRuns: true,
    });
  });

  test("GET /api/graph/landscape/replay parses run and landscape filters separately", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/replay?windowDays=7&limit=20&landscapeLimit=200&runStatus=degraded&landscapeStatus=current&relationAxes=session&minSelectedCount=2&minFeedbackCount=4&minSimilarity=0.8&semanticTopK=5&includeRuns=false",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeReplaySnapshotMock).toHaveBeenCalledWith({
      windowDays: 7,
      limit: 20,
      landscapeLimit: 200,
      runStatus: "degraded",
      landscapeStatus: "current",
      relationAxes: ["session"],
      minSelectedCount: 2,
      minFeedbackCount: 4,
      minSimilarity: 0.8,
      semanticTopK: 5,
      includeRuns: false,
    });
  });

  test("GET /api/graph/landscape/replay/compare applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay/compare");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeReplayComparisonResponseSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeReplayComparisonMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      includeRuns: true,
    });
  });

  test("GET /api/graph/landscape/cache-status returns cache status", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/cache-status");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeSnapshotCacheStatusSchema.safeParse(json).success).toBe(true);
    expect(getLandscapeSnapshotCacheStatusMock).toHaveBeenCalledTimes(1);
  });

  test("GET /api/graph/landscape/replay/compare parses comparison filters", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/replay/compare?windowDays=14&limit=25&runStatus=failed&currentLimit=8&includeRuns=false",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeReplayComparisonMock).toHaveBeenCalledWith({
      windowDays: 14,
      limit: 25,
      runStatus: "failed",
      currentLimit: 8,
      includeRuns: false,
    });
  });

  test("GET /api/graph/landscape/trajectory/:runId applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/trajectory/run-1");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeTrajectoryResultSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeTrajectoryMock).toHaveBeenCalledWith({
      runId: "run-1",
      includeCandidates: true,
      limit: 200,
    });
  });

  test("GET /api/graph/landscape/trajectory/:runId parses query", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/trajectory/run-1?includeCandidates=false&limit=25",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeTrajectoryMock).toHaveBeenCalledWith({
      runId: "run-1",
      includeCandidates: false,
      limit: 25,
    });
  });

  test("POST /api/graph/landscape/replay/queue applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    expect(materializeLandscapeReviewItemsMock).toHaveBeenCalledWith({
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
  });

  test("POST /api/graph/landscape/replay/queue returns status from review-items error", async () => {
    const app = buildApp();
    materializeLandscapeReviewItemsMock.mockRejectedValueOnce(
      new LandscapeReviewItemsErrorMock(400, "unsupported sources in AQ-1A"),
    );

    const response = await app.request("/api/graph/landscape/replay/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dryRun: true,
        sources: ["landscape_snapshot"],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported sources in AQ-1A",
    });
  });

  test("POST /api/graph/landscape/replay/queue accepts contradiction source", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dryRun: true,
        sources: ["contradiction_detection"],
      }),
    });
    expect(response.status).toBe(200);
    expect(materializeLandscapeReviewItemsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        sources: ["contradiction_detection"],
      }),
    );
  });

  test("POST /api/graph/landscape/review-items/candidates parses body and returns result", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/review-items/candidates", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "pending",
        limit: 10,
        dryRun: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(createLandscapeReviewCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        limit: 10,
        dryRun: true,
      }),
    );
    const json = await response.json();
    expect(json.result.processedCount).toBe(1);
    expect(json.result.items).toHaveLength(1);
  });

  test("PATCH /api/graph/landscape/review-items/:id/candidate-links/:linkId updates approval status", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/review-items/review-item-1/candidate-links/link-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "approved",
          note: "approved manually",
          actor: "reviewer",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(updateLandscapeReviewCandidateLinkMock).toHaveBeenCalledWith("review-item-1", "link-1", {
      status: "approved",
      note: "approved manually",
      actor: "reviewer",
    });
    const json = await response.json();
    expect(json.link.status).toBe("approved");
    expect(json.link.id).toBe("link-1");
  });

  test("PATCH /api/graph/landscape/review-items/:id/candidate-links/:linkId returns 409 on invalid transition", async () => {
    const app = buildApp();
    updateLandscapeReviewCandidateLinkMock.mockRejectedValueOnce(
      new LandscapeReviewCandidateLinkErrorMock(
        409,
        "invalid link status transition: finalized -> approved",
      ),
    );
    const response = await app.request(
      "/api/graph/landscape/review-items/review-item-1/candidate-links/link-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "approved",
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "invalid link status transition: finalized -> approved",
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
