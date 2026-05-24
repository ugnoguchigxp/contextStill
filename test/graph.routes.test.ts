import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { landscapeSnapshotSchema } from "../src/shared/schemas/landscape.schema.js";

const { buildLandscapeSnapshotMock } = vi.hoisted(() => ({
  buildLandscapeSnapshotMock: vi.fn(),
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

describe("graph routes landscape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeSnapshotMock.mockResolvedValue(validLandscapeSnapshot());
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
});
