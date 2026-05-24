import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildLandscapeTrajectory } from "../src/modules/landscape/landscape-trajectory.service.js";

const { loadLandscapeTrajectoryMock } = vi.hoisted(() => ({
  loadLandscapeTrajectoryMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-trajectory.repository.js", () => ({
  loadLandscapeTrajectory: loadLandscapeTrajectoryMock,
}));

describe("landscape trajectory service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns trajectory payload with diagnostics and limit warning", async () => {
    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-1",
        goal: "trace me",
        retrievalMode: "task_context",
        status: "ok",
        source: "mcp",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {
          diagnostics: {
            retrievalStats: {
              candidateTraceSavedCount: 200,
              candidateTraceTruncated: true,
              candidateTraceLimit: 200,
              candidateTraceSkippedReason: null,
            },
          },
        },
      },
      selectedKnowledgeIds: ["k1"],
      stageCounts: {
        totalCandidates: 3,
        textHit: 2,
        vectorHit: 1,
        merged: 3,
        finalRanked: 2,
        selected: 1,
        suppressed: 2,
      },
      candidates: [
        {
          itemKind: "rule",
          itemId: "k1",
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
        },
      ],
      communitySummary: [],
    });

    const result = await buildLandscapeTrajectory({
      runId: "run-1",
      includeCandidates: true,
      limit: 1,
    });

    expect(result).not.toBeNull();
    expect(result?.traceAvailable).toBe(true);
    expect(result?.warnings).toContain("candidate trace was truncated at compile time");
    expect(result?.warnings).toContain("candidate list truncated by query limit");
    expect(result?.diagnostics.candidateTraceSavedCount).toBe(200);
    expect(result?.stageCounts.totalCandidates).toBe(3);
  });

  test("reports trace unavailable when candidate trace rows are missing", async () => {
    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-2",
        goal: "missing trace",
        retrievalMode: "task_context",
        status: "degraded",
        source: "cli",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {},
      },
      selectedKnowledgeIds: [],
      stageCounts: {
        totalCandidates: 0,
        textHit: 0,
        vectorHit: 0,
        merged: 0,
        finalRanked: 0,
        selected: 0,
        suppressed: 0,
      },
      candidates: [],
      communitySummary: [],
    });

    const result = await buildLandscapeTrajectory({
      runId: "run-2",
      includeCandidates: true,
      limit: 50,
    });

    expect(result).not.toBeNull();
    expect(result?.traceAvailable).toBe(false);
    expect(result?.warnings).toEqual(["trace unavailable"]);
    expect(result?.diagnostics.candidateTraceSavedCount).toBeNull();
  });
});
