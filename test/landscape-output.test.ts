import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/landscape-options.js";
import {
  buildContradictionDryRunSummary,
  printContradictionDryRunSummary,
  printQueueCreateCandidatesSummary,
  printQueueListSummary,
  printQueueMaterializeSummary,
  printReplayComparisonSummary,
  printReplaySummary,
  printSnapshotCacheStatus,
  printSummary,
  printTrajectorySummary,
  queueStatusForCandidateCreation,
  warmupLandscapeSnapshotCache,
} from "../src/cli/landscape-output.js";

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: vi.fn(async () => ({})),
}));
vi.mock("../src/modules/landscape/landscape-replay.service.js", () => ({
  buildLandscapeReplaySnapshot: vi.fn(async () => ({})),
}));
vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: vi.fn(async () => ({})),
}));

const snapshot = {
  windowDays: 30,
  basis: { status: "ok" },
  stats: {
    totalCommunities: 2,
    strongAttractorCount: 1,
    usefulAttractorCount: 1,
    negativeCandidateCount: 0,
    overSelectedNotUsedCount: 0,
    deadZoneReachabilityCount: 0,
    deadZoneStaleCount: 0,
    insufficientFeedbackCommunities: 0,
  },
  risks: [
    {
      severity: "high",
      communityRank: 1,
      communityLabel: "Queue",
      type: "stale",
      reason: "decayed",
    },
  ],
};

describe("landscape CLI output", () => {
  test("prints snapshot, replay, queue and cache summaries", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printSummary(snapshot as any);
    printSummary({ ...snapshot, risks: [] } as any);
    printReplayComparisonSummary({
      windowDays: 7,
      basis: { runStatus: "ok", mode: "live" },
      comparedRunCount: 1,
      baselineSelectedItemCount: 2,
      currentRetrievedItemCount: 2,
      retainedItemCount: 1,
      missingFromCurrentItemCount: 0,
      newlyRetrievedItemCount: 1,
      usedBaselineLostItemCount: 0,
      averageOverlapRate: 0.5,
      currentNoMatchRunCount: 0,
      comparisonCounts: {
        stable: 1,
        drifted: 0,
        lost_baseline: 0,
        new_only: 1,
        no_current_match: 0,
      },
      recompilePlan: { writesCompileRuns: 0, blockers: [] },
      scoreTuning: {
        highChurnRunCount: 0,
        negativeFeedbackRunCount: 0,
        lostUsedBaselineRunCount: 0,
        averageReplacementRate: 0.1,
      },
      promotionGateSummary: {
        gateMode: "observe",
        affectedRunCount: 0,
        productionEnabled: false,
      },
      compileInterventionPlan: {
        strategy: "none",
        candidateRunCount: 0,
        productionEnabled: false,
      },
      appliesToRefineCandidates: [],
    } as any);
    printReplaySummary({
      windowDays: 7,
      basis: { runStatus: "ok", landscapeStatus: "active" },
      replayRunCount: 2,
      selectedKnowledgeCount: 3,
      missingKnowledgeCount: 1,
      acceptanceWindow: { acceptedCountWindow: 1, unknownAcceptanceCountWindow: 0 },
      communityComparison: { alignedCount: 1, semanticReachableDeadZoneCount: 0 },
      facetSummaries: [
        { facetKind: "runStatus", replayRunCount: 2, feedbackCoverageRate: 0.5 },
        { facetKind: "other", replayRunCount: 1, feedbackCoverageRate: 1 },
      ],
    } as any);
    printReplaySummary({
      windowDays: 7,
      basis: { runStatus: "ok", landscapeStatus: "active" },
      replayRunCount: 0,
      selectedKnowledgeCount: 0,
      missingKnowledgeCount: 0,
      acceptanceWindow: { acceptedCountWindow: 0, unknownAcceptanceCountWindow: 0 },
      communityComparison: { alignedCount: 0, semanticReachableDeadZoneCount: 0 },
      facetSummaries: [],
    } as any);
    printQueueMaterializeSummary({
      dryRun: true,
      candidateCount: 1,
      insertedCount: 0,
      existingCount: 1,
      skippedCount: 0,
    } as any);
    printQueueMaterializeSummary({
      dryRun: false,
      candidateCount: 1,
      insertedCount: 1,
      existingCount: 0,
      skippedCount: 0,
    } as any);
    printQueueListSummary({ count: 3 } as any);
    printQueueCreateCandidatesSummary({
      dryRun: true,
      processedCount: 1,
      createdCount: 0,
      existingCount: 1,
    } as any);
    printQueueCreateCandidatesSummary({
      dryRun: false,
      processedCount: 1,
      createdCount: 1,
      existingCount: 0,
    } as any);
    printTrajectorySummary(null as any);
    printTrajectorySummary({
      run: { id: "r1", status: "ok", retrievalMode: "live" },
    } as any);
    printSnapshotCacheStatus({ enabled: true, ttlSeconds: 30 } as any);
    printSnapshotCacheStatus({ enabled: false, ttlSeconds: 0 } as any);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  test("queueStatusForCandidateCreation only allows pending or reviewing", () => {
    expect(queueStatusForCandidateCreation("all")).toBe("pending");
    expect(queueStatusForCandidateCreation("pending")).toBe("pending");
    expect(queueStatusForCandidateCreation("reviewing")).toBe("reviewing");
    expect(() => queueStatusForCandidateCreation("resolved")).toThrow(
      "--queue-create-candidates requires --queue-status pending|reviewing",
    );
  });

  test("contradiction dry-run summary uses payload, evidence and unknown pair keys", () => {
    expect(buildContradictionDryRunSummary({ candidates: [], skippedCount: 0 } as any)).toBeNull();
    const summary = buildContradictionDryRunSummary({
      skippedCount: 2,
      candidates: [
        {
          source: "contradiction_detection",
          confidence: "high",
          evidence: [],
          payload: { pairKey: "a::b" },
        },
        {
          reason: "contradiction_review",
          confidence: "medium",
          evidence: [],
          payload: { leftKnowledgeId: "l", rightKnowledgeId: "r" },
        },
        {
          source: "contradiction_detection",
          confidence: "low",
          evidence: ["pair=from-evidence"],
          payload: {},
        },
        {
          source: "contradiction_detection",
          confidence: "low",
          evidence: [],
          payload: {},
        },
        { source: "other", confidence: "high", evidence: [], payload: {} },
      ],
    } as any);
    expect(summary).toMatchObject({
      candidateCount: 4,
      confidenceDistribution: { high: 1, medium: 1, low: 2 },
      materializeSkippedCount: 2,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printContradictionDryRunSummary(null);
    printContradictionDryRunSummary(summary);
    expect(log).toHaveBeenCalledWith("Contradiction dry-run summary:");
    log.mockRestore();
  });

  test("warmupLandscapeSnapshotCache visits every cache type", async () => {
    const options = parseArgs([]);
    await expect(
      warmupLandscapeSnapshotCache(
        ["landscape_snapshot", "landscape_replay_snapshot", "landscape_replay_comparison"],
        options,
      ),
    ).resolves.toEqual([
      "landscape_snapshot",
      "landscape_replay_snapshot",
      "landscape_replay_comparison",
    ]);
  });
});
