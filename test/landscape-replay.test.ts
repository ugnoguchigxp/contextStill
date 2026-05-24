import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  buildGraphSnapshotMock,
  buildLandscapeCommunityComparisonMock,
  buildLandscapeSnapshotMock,
  loadLandscapeReplayCorpusMock,
} = vi.hoisted(() => ({
  buildGraphSnapshotMock: vi.fn(),
  buildLandscapeCommunityComparisonMock: vi.fn(),
  buildLandscapeSnapshotMock: vi.fn(),
  loadLandscapeReplayCorpusMock: vi.fn(),
}));

vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: buildGraphSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: buildLandscapeSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-replay.repository.js", () => ({
  loadLandscapeReplayCorpus: loadLandscapeReplayCorpusMock,
}));

vi.mock("../src/modules/landscape/landscape-community-comparison.js", () => ({
  buildLandscapeCommunityComparison: buildLandscapeCommunityComparisonMock,
}));

import { buildLandscapeReplaySnapshot } from "../src/modules/landscape/landscape-replay.service.js";

const communityKey = "a".repeat(64);

function landscapeCommunity() {
  return {
    communityId: "community:1",
    communityKey,
    communityLabel: "Core",
    communityRank: 1,
    size: 2,
    classification: {
      primary: "strong_attractor",
      flags: [],
      confidence: "medium",
      reason: "used rate is high",
    },
    feedback: {
      feedbackConfidence: "medium",
    },
  };
}

function emptyComparison() {
  return {
    universeKnowledgeCount: 2,
    comparedKnowledgeCount: 2,
    missingRelationAssignmentCount: 0,
    missingSemanticAssignmentCount: 0,
    alignedCount: 1,
    semanticSplitCount: 0,
    semanticMergeCount: 0,
    relationOrphanCount: 0,
    semanticReachableDeadZoneCount: 0,
    communities: [],
  };
}

describe("landscape replay service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeSnapshotMock.mockResolvedValue({
      generatedAt: "2026-05-24T00:00:00.000Z",
      windowDays: 30,
      communities: [landscapeCommunity()],
      risks: [],
      stats: {},
      basis: {},
      thresholds: {},
    });
    buildGraphSnapshotMock.mockResolvedValue({
      nodes: [
        {
          id: "knowledge:k1",
          kind: "knowledge",
          communityKey,
          communityLabel: "Core",
          communityRank: 1,
          communitySize: 2,
        },
        {
          id: "knowledge:k2",
          kind: "knowledge",
          communityKey,
          communityLabel: "Core",
          communityRank: 1,
          communitySize: 2,
        },
      ],
      edges: [],
      communities: [],
      supernodes: [],
      superedges: [],
      stats: {},
    });
    loadLandscapeReplayCorpusMock.mockResolvedValue({
      runs: [
        {
          id: "run-1",
          goal: "Replay the basin",
          intent: "test",
          repoPath: "/repo",
          input: {
            technologies: ["TypeScript"],
            domains: ["graph-ui"],
            changeTypes: ["feature"],
          },
          retrievalMode: "hybrid",
          status: "ok",
          degradedReasons: [],
          source: "mcp",
          packSnapshot: null,
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ],
      packItems: [
        {
          runId: "run-1",
          itemKind: "rule",
          itemId: "k1",
          score: 0.9,
          rankingReason: "",
          sourceRefs: [],
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
        {
          runId: "run-1",
          itemKind: "procedure",
          itemId: "k2",
          score: 0.8,
          rankingReason: "",
          sourceRefs: [],
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
        {
          runId: "run-1",
          itemKind: "rule",
          itemId: "missing",
          score: 0.7,
          rankingReason: "",
          sourceRefs: [],
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ],
      usageEvents: [
        {
          runId: "run-1",
          knowledgeId: "k1",
          verdict: "used",
          actor: "agent",
          reason: null,
          metadata: { agenticAccepted: true },
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
        {
          runId: "run-1",
          knowledgeId: "k2",
          verdict: "not_used",
          actor: "system",
          reason: null,
          metadata: {},
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ],
    });
    buildLandscapeCommunityComparisonMock.mockResolvedValue(emptyComparison());
  });

  test("annotates compile runs with current landscape basin traces", async () => {
    const snapshot = await buildLandscapeReplaySnapshot({
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

    expect(snapshot.replayRunCount).toBe(1);
    expect(snapshot.selectedKnowledgeCount).toBe(3);
    expect(snapshot.missingKnowledgeCount).toBe(1);
    expect(snapshot.acceptanceWindow.acceptedCountWindow).toBe(1);
    expect(snapshot.acceptanceWindow.unknownAcceptanceCountWindow).toBe(1);
    expect(snapshot.communityReplaySummaries[0]?.acceptanceWindow.acceptedCountWindow).toBe(1);
    expect(
      snapshot.communityReplaySummaries[0]?.acceptanceWindow.unknownAcceptanceCountWindow,
    ).toBe(1);
    expect(
      snapshot.facetSummaries.find((facet) => facet.facetKind === "domain")?.acceptanceWindow
        .acceptedCountWindow,
    ).toBe(1);
    expect(snapshot.runs[0]?.basinTrace[0]).toEqual(
      expect.objectContaining({
        communityKey,
        selectedItemCount: 2,
        selectedRanks: [1, 2],
        classificationAtAnalysis: "strong_attractor",
        explanation: "aligned_attractor",
      }),
    );
    expect(snapshot.facetSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          facetKind: "technology",
          facetValue: "typescript",
          replayRunCount: 1,
        }),
      ]),
    );
  });
});
