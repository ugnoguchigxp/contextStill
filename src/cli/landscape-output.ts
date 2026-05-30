import { buildLandscapeReplayComparison } from "../modules/landscape/landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "../modules/landscape/landscape-replay.service.js";
import type { createLandscapeReviewCandidates } from "../modules/landscape/landscape-review-candidate.service.js";
import type {
  listLandscapeReviewItems,
  materializeLandscapeReviewItems,
} from "../modules/landscape/landscape-review-items.service.js";
import type {
  LandscapeSnapshotCacheType,
  getLandscapeSnapshotCacheStatus,
} from "../modules/landscape/landscape-snapshot-cache.service.js";
import type { buildLandscapeTrajectory } from "../modules/landscape/landscape-trajectory.service.js";
import { buildLandscapeSnapshot } from "../modules/landscape/landscape.service.js";
import type { CliOptions } from "./landscape-options.js";

export function printSummary(snapshot: Awaited<ReturnType<typeof buildLandscapeSnapshot>>) {
  console.log(`Landscape Snapshot (${snapshot.windowDays}d, ${snapshot.basis.status})`);
  console.log(`Communities: ${snapshot.stats.totalCommunities}`);
  console.log(`Strong attractors: ${snapshot.stats.strongAttractorCount}`);
  console.log(`Useful attractors: ${snapshot.stats.usefulAttractorCount}`);
  console.log(`Negative candidates: ${snapshot.stats.negativeCandidateCount}`);
  console.log(`Over-selected not used: ${snapshot.stats.overSelectedNotUsedCount}`);
  console.log(`Dead reachability risks: ${snapshot.stats.deadZoneReachabilityCount}`);
  console.log(`Dead stale: ${snapshot.stats.deadZoneStaleCount}`);
  console.log(`Feedback insufficient: ${snapshot.stats.insufficientFeedbackCommunities}`);

  if (snapshot.risks.length === 0) return;
  console.log("");
  console.log("Top risks:");
  for (const risk of snapshot.risks.slice(0, 10)) {
    console.log(
      `- [${risk.severity}] #${risk.communityRank} ${risk.communityLabel} (${risk.type}) ${risk.reason}`,
    );
  }
}

export function printReplayComparisonSummary(
  comparison: Awaited<ReturnType<typeof buildLandscapeReplayComparison>>,
) {
  console.log(
    `Landscape Replay Compare (${comparison.windowDays}d, runs=${comparison.basis.runStatus}, mode=${comparison.basis.mode})`,
  );
  console.log(`Runs: ${comparison.comparedRunCount}`);
  console.log(`Baseline selected: ${comparison.baselineSelectedItemCount}`);
  console.log(`Current retrieved: ${comparison.currentRetrievedItemCount}`);
  console.log(`Retained: ${comparison.retainedItemCount}`);
  console.log(`Missing from current: ${comparison.missingFromCurrentItemCount}`);
  console.log(`Newly retrieved: ${comparison.newlyRetrievedItemCount}`);
  console.log(`Used baseline lost: ${comparison.usedBaselineLostItemCount}`);
  console.log(`Average overlap: ${comparison.averageOverlapRate.toFixed(2)}`);
  console.log(`No current match runs: ${comparison.currentNoMatchRunCount}`);
  console.log(
    `Comparison counts: stable=${comparison.comparisonCounts.stable} drifted=${comparison.comparisonCounts.drifted} lost=${comparison.comparisonCounts.lost_baseline} new_only=${comparison.comparisonCounts.new_only} no_current=${comparison.comparisonCounts.no_current_match}`,
  );
  console.log(
    `Dry-run recompile: writes=${comparison.recompilePlan.writesCompileRuns} blockers=${comparison.recompilePlan.blockers.length}`,
  );
  console.log(
    `Score tuning: high_churn=${comparison.scoreTuning.highChurnRunCount} negative_feedback=${comparison.scoreTuning.negativeFeedbackRunCount} lost_used_runs=${comparison.scoreTuning.lostUsedBaselineRunCount} avg_replacement=${comparison.scoreTuning.averageReplacementRate.toFixed(2)}`,
  );
  console.log(
    `Promotion gate: ${comparison.promotionGateSummary.gateMode} affected_runs=${comparison.promotionGateSummary.affectedRunCount} production=${comparison.promotionGateSummary.productionEnabled}`,
  );
  console.log(
    `Compile intervention: ${comparison.compileInterventionPlan.strategy} candidates=${comparison.compileInterventionPlan.candidateRunCount} production=${comparison.compileInterventionPlan.productionEnabled}`,
  );
  console.log(`appliesTo refine candidates: ${comparison.appliesToRefineCandidates.length}`);
}

export function printReplaySummary(
  snapshot: Awaited<ReturnType<typeof buildLandscapeReplaySnapshot>>,
) {
  const runFacetSummaries = snapshot.facetSummaries.filter(
    (facet) => facet.facetKind === "runStatus",
  );
  const runFacetCount = runFacetSummaries.reduce((sum, facet) => sum + facet.replayRunCount, 0);
  const feedbackCoverage =
    runFacetCount > 0
      ? runFacetSummaries.reduce(
          (sum, facet) => sum + facet.feedbackCoverageRate * facet.replayRunCount,
          0,
        ) / runFacetCount
      : 0;
  console.log(
    `Landscape Replay (${snapshot.windowDays}d, runs=${snapshot.basis.runStatus}, landscape=${snapshot.basis.landscapeStatus})`,
  );
  console.log(`Runs: ${snapshot.replayRunCount}`);
  console.log(`Selected knowledge: ${snapshot.selectedKnowledgeCount}`);
  console.log(`Missing knowledge: ${snapshot.missingKnowledgeCount}`);
  console.log(`Feedback coverage: ${feedbackCoverage.toFixed(2)}`);
  console.log(`Accepted events: ${snapshot.acceptanceWindow.acceptedCountWindow}`);
  console.log(
    `Unknown acceptance events: ${snapshot.acceptanceWindow.unknownAcceptanceCountWindow}`,
  );
  console.log(`Semantic aligned: ${snapshot.communityComparison.alignedCount}`);
  console.log(
    `Semantic reachable dead zones: ${snapshot.communityComparison.semanticReachableDeadZoneCount}`,
  );
}

export function printQueueMaterializeSummary(
  result: Awaited<ReturnType<typeof materializeLandscapeReviewItems>>,
) {
  console.log(result.dryRun ? "Landscape Action Queue dry-run" : "Landscape Action Queue");
  console.log(`Candidates: ${result.candidateCount}`);
  console.log(`Inserted: ${result.insertedCount}`);
  console.log(`Existing: ${result.existingCount}`);
  console.log(`Skipped: ${result.skippedCount}`);
}

export function printQueueListSummary(
  result: Awaited<ReturnType<typeof listLandscapeReviewItems>>,
) {
  console.log(`Landscape Action Queue items: ${result.count}`);
}

export function queueStatusForCandidateCreation(
  value: CliOptions["queueStatus"],
): "pending" | "reviewing" {
  if (value === "all") return "pending";
  if (value === "pending" || value === "reviewing") return value;
  throw new Error("--queue-create-candidates requires --queue-status pending|reviewing");
}

export function printQueueCreateCandidatesSummary(
  result: Awaited<ReturnType<typeof createLandscapeReviewCandidates>>,
) {
  console.log(result.dryRun ? "Landscape Candidate Draft dry-run" : "Landscape Candidate Draft");
  console.log(`Processed: ${result.processedCount}`);
  console.log(`Created: ${result.createdCount}`);
  console.log(`Existing: ${result.existingCount}`);
}

export function printTrajectorySummary(
  trajectory: Awaited<ReturnType<typeof buildLandscapeTrajectory>>,
): void {
  if (!trajectory) return;
  console.log(
    `Landscape Trajectory run=${trajectory.run.id} status=${trajectory.run.status} mode=${trajectory.run.retrievalMode}`,
  );
}

export function printSnapshotCacheStatus(
  status: Awaited<ReturnType<typeof getLandscapeSnapshotCacheStatus>>,
): void {
  console.log(`Landscape Snapshot Cache: ${status.enabled ? "enabled" : "disabled"}`);
  console.log(`TTL: ${status.ttlSeconds}s`);
}

function contradictionPairLabel(candidate: {
  evidence: string[];
  payload: Record<string, unknown>;
}): string {
  const payloadPairKey =
    typeof candidate.payload.pairKey === "string" ? candidate.payload.pairKey : "";
  if (payloadPairKey) return payloadPairKey;
  const leftKnowledgeId =
    typeof candidate.payload.leftKnowledgeId === "string" ? candidate.payload.leftKnowledgeId : "";
  const rightKnowledgeId =
    typeof candidate.payload.rightKnowledgeId === "string"
      ? candidate.payload.rightKnowledgeId
      : "";
  if (leftKnowledgeId && rightKnowledgeId) return `${leftKnowledgeId}::${rightKnowledgeId}`;
  const pairEvidence = candidate.evidence.find((item) => item.startsWith("pair="));
  if (pairEvidence) return pairEvidence.slice("pair=".length).trim();
  return "unknown";
}

export function buildContradictionDryRunSummary(
  result: Awaited<ReturnType<typeof materializeLandscapeReviewItems>>,
) {
  const contradictionCandidates = result.candidates.filter(
    (candidate) =>
      candidate.source === "contradiction_detection" || candidate.reason === "contradiction_review",
  );
  if (contradictionCandidates.length === 0) return null;

  const confidenceDistribution = { low: 0, medium: 0, high: 0 };
  const pairCounts = new Map<string, number>();
  for (const candidate of contradictionCandidates) {
    if (candidate.confidence === "high") confidenceDistribution.high += 1;
    else if (candidate.confidence === "medium") confidenceDistribution.medium += 1;
    else confidenceDistribution.low += 1;
    const pair = contradictionPairLabel(candidate);
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  let topNoisyPair: { pairKey: string; count: number } | null = null;
  for (const [pairKey, count] of pairCounts.entries()) {
    if (!topNoisyPair || count > topNoisyPair.count) {
      topNoisyPair = { pairKey, count };
    }
  }

  return {
    candidateCount: contradictionCandidates.length,
    confidenceDistribution,
    topNoisyPair,
    materializeSkippedCount: result.skippedCount,
  };
}

export function printContradictionDryRunSummary(
  summary: ReturnType<typeof buildContradictionDryRunSummary>,
): void {
  if (!summary) return;
  console.log("");
  console.log("Contradiction dry-run summary:");
  console.log(`Candidates: ${summary.candidateCount}`);
  console.log(
    `Confidence: high=${summary.confidenceDistribution.high} medium=${summary.confidenceDistribution.medium} low=${summary.confidenceDistribution.low}`,
  );
}

export async function warmupLandscapeSnapshotCache(
  types: LandscapeSnapshotCacheType[],
  options: CliOptions,
): Promise<LandscapeSnapshotCacheType[]> {
  const warmed: LandscapeSnapshotCacheType[] = [];
  for (const snapshotType of types) {
    if (snapshotType === "landscape_snapshot") {
      await buildLandscapeSnapshot({
        windowDays: options.windowDays,
        limit: options.limit,
        status: options.status,
        relationAxes: options.relationAxes,
        minSelectedCount: options.minSelectedCount,
        minFeedbackCount: options.minFeedbackCount,
      });
      warmed.push(snapshotType);
      continue;
    }
    if (snapshotType === "landscape_replay_snapshot") {
      await buildLandscapeReplaySnapshot({
        windowDays: options.windowDays,
        limit: options.limit,
        landscapeLimit: options.landscapeLimit,
        runStatus: options.runStatus,
        landscapeStatus: options.landscapeStatus,
        relationAxes: options.relationAxes,
        minSelectedCount: options.minSelectedCount,
        minFeedbackCount: options.minFeedbackCount,
        minSimilarity: options.minSimilarity,
        semanticTopK: options.semanticTopK,
        includeRuns: false,
      });
      warmed.push(snapshotType);
      continue;
    }
    await buildLandscapeReplayComparison({
      windowDays: options.windowDays,
      limit: options.limit,
      runStatus: options.runStatus,
      currentLimit: options.currentLimit,
      includeRuns: true,
    });
    warmed.push(snapshotType);
  }
  return warmed;
}
