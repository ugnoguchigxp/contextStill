import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  landscapeReplayComparisonResponseSchema,
  landscapeReplaySnapshotSchema,
} from "../src/shared/schemas/landscape-replay.schema.js";
import { landscapeSnapshotSchema } from "../src/shared/schemas/landscape.schema.js";

const {
  buildLandscapeReplayComparisonMock,
  buildLandscapeReplaySnapshotMock,
  buildLandscapeSnapshotMock,
} = vi.hoisted(() => ({
  buildLandscapeReplayComparisonMock: vi.fn(),
  buildLandscapeReplaySnapshotMock: vi.fn(),
  buildLandscapeSnapshotMock: vi.fn(),
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

describe("graph routes landscape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeSnapshotMock.mockResolvedValue(validLandscapeSnapshot());
    buildLandscapeReplaySnapshotMock.mockResolvedValue(validReplaySnapshot());
    buildLandscapeReplayComparisonMock.mockResolvedValue(validReplayComparison());
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
});
