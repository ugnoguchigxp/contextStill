import { closeDbPool } from "../db/index.js";
import { buildLandscapeReplayComparison } from "../modules/landscape/landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "../modules/landscape/landscape-replay.service.js";
import { buildLandscapeSnapshot } from "../modules/landscape/landscape.service.js";

type CliOptions = {
  windowDays: number;
  limit: number;
  landscapeLimit: number;
  status: "current" | "active" | "draft" | "deprecated" | "all";
  runStatus: "ok" | "degraded" | "failed" | "all";
  landscapeStatus: "current" | "active" | "draft" | "deprecated" | "all";
  relationAxes: Array<"session" | "project" | "source">;
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  currentLimit: number;
  replay: boolean;
  replayCompare: boolean;
  compareCommunities: boolean;
  json: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parsePositiveInt(
  args: string[],
  index: number,
  name: string,
  max?: number,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be ${max} or less`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

function parseRelationAxes(value: string): Array<"session" | "project" | "source"> {
  const axes = new Set<"session" | "project" | "source">();
  for (const token of value.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "session" || normalized === "project" || normalized === "source") {
      axes.add(normalized);
    }
  }
  return axes.size > 0 ? [...axes] : ["session", "project", "source"];
}

function parseStatus(value: string): CliOptions["status"] {
  if (
    value === "current" ||
    value === "active" ||
    value === "draft" ||
    value === "deprecated" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("--status must be one of current|active|draft|deprecated|all");
}

function parseRunStatus(value: string): CliOptions["runStatus"] {
  if (value === "ok" || value === "degraded" || value === "failed" || value === "all") {
    return value;
  }
  throw new Error("--run-status must be one of ok|degraded|failed|all");
}

function parseUnitNumber(
  args: string[],
  index: number,
  name: string,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    windowDays: 30,
    limit: 1000,
    landscapeLimit: 1000,
    status: "active",
    runStatus: "all",
    landscapeStatus: "active",
    relationAxes: ["session", "project", "source"],
    minSelectedCount: 3,
    minFeedbackCount: 3,
    minSimilarity: 0.72,
    semanticTopK: 3,
    currentLimit: 12,
    replay: false,
    replayCompare: false,
    compareCommunities: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--replay") {
      options.replay = true;
      continue;
    }
    if (arg === "--compare-communities") {
      options.replay = true;
      options.compareCommunities = true;
      continue;
    }
    if (arg === "--replay-compare" || arg === "--recompile-compare") {
      options.replayCompare = true;
      continue;
    }
    if (arg === "--window-days" || arg.startsWith("--window-days=")) {
      const parsed = parsePositiveInt(args, index, "--window-days", 180);
      options.windowDays = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = parsePositiveInt(args, index, "--limit", 1000);
      options.limit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--landscape-limit" || arg.startsWith("--landscape-limit=")) {
      const parsed = parsePositiveInt(args, index, "--landscape-limit", 2000);
      options.landscapeLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--min-selected-count" || arg.startsWith("--min-selected-count=")) {
      const parsed = parsePositiveInt(args, index, "--min-selected-count", 100);
      options.minSelectedCount = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--min-feedback-count" || arg.startsWith("--min-feedback-count=")) {
      const parsed = parsePositiveInt(args, index, "--min-feedback-count", 100);
      options.minFeedbackCount = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--status" || arg.startsWith("--status=")) {
      const value = readArgValue(args, index, "--status");
      options.status = parseStatus(value);
      options.landscapeStatus = options.status;
      if (arg === "--status") index += 1;
      continue;
    }
    if (arg === "--run-status" || arg.startsWith("--run-status=")) {
      const value = readArgValue(args, index, "--run-status");
      options.runStatus = parseRunStatus(value);
      if (arg === "--run-status") index += 1;
      continue;
    }
    if (arg === "--landscape-status" || arg.startsWith("--landscape-status=")) {
      const value = readArgValue(args, index, "--landscape-status");
      options.landscapeStatus = parseStatus(value);
      if (arg === "--landscape-status") index += 1;
      continue;
    }
    if (arg === "--relation-axes" || arg.startsWith("--relation-axes=")) {
      const value = readArgValue(args, index, "--relation-axes");
      options.relationAxes = parseRelationAxes(value);
      if (arg === "--relation-axes") index += 1;
      continue;
    }
    if (arg === "--min-similarity" || arg.startsWith("--min-similarity=")) {
      const parsed = parseUnitNumber(args, index, "--min-similarity");
      options.minSimilarity = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--semantic-top-k" || arg.startsWith("--semantic-top-k=")) {
      const parsed = parsePositiveInt(args, index, "--semantic-top-k", 10);
      options.semanticTopK = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--current-limit" || arg.startsWith("--current-limit=")) {
      const parsed = parsePositiveInt(args, index, "--current-limit", 50);
      options.currentLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printSummary(snapshot: Awaited<ReturnType<typeof buildLandscapeSnapshot>>) {
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

function printReplayComparisonSummary(
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

  if (comparison.rankingExperiments.length > 0) {
    console.log("");
    console.log("Ranking experiments:");
    for (const experiment of comparison.rankingExperiments) {
      console.log(
        `- ${experiment.experiment} target_runs=${experiment.targetRunCount} overlap=${experiment.estimatedAverageOverlapRate.toFixed(2)} used_lost=${experiment.estimatedUsedBaselineLostItemCount} production=${experiment.productionEnabled}`,
      );
    }
  }

  const riskyRuns = comparison.runs
    .filter(
      (run) =>
        run.comparison === "lost_baseline" ||
        run.comparison === "no_current_match" ||
        run.usedBaselineLostKnowledgeIds.length > 0,
    )
    .slice(0, 10);
  if (riskyRuns.length === 0) return;
  console.log("");
  console.log("Top replay drift:");
  for (const run of riskyRuns) {
    console.log(
      `- ${run.runId} ${run.comparison} overlap=${run.overlapRate.toFixed(2)} used_lost=${run.usedBaselineLostKnowledgeIds.length} goal=${run.goal.slice(0, 80)}`,
    );
  }
}

function printReplaySummary(snapshot: Awaited<ReturnType<typeof buildLandscapeReplaySnapshot>>) {
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

  if (snapshot.facetSummaries.length > 0) {
    console.log("");
    console.log("Top facet risks:");
    for (const facet of snapshot.facetSummaries.slice(0, 10)) {
      const riskCount =
        facet.negativeCandidateHitCount + facet.overSelectedHitCount + facet.deadZoneMissCount;
      console.log(
        `- ${facet.facetKind}:${facet.facetValue} risk=${riskCount} used=${facet.usedRate.toFixed(2)} off_topic=${facet.offTopicRate.toFixed(2)} wrong=${facet.wrongRate.toFixed(2)}`,
      );
    }
  }

  if (snapshot.communityComparison.communities.length > 0) {
    console.log("");
    console.log("Top community comparison:");
    for (const community of snapshot.communityComparison.communities.slice(0, 10)) {
      console.log(
        `- #${community.relationCommunityRank} ${community.relationCommunityLabel} ${community.comparison} overlap=${community.jaccardOverlap.toFixed(2)} selected_neighbors=${community.selectedNeighborCountWindow}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.replayCompare) {
    const comparison = await buildLandscapeReplayComparison({
      windowDays: options.windowDays,
      limit: options.limit,
      runStatus: options.runStatus,
      currentLimit: options.currentLimit,
      includeRuns: true,
    });
    if (options.json) {
      console.log(JSON.stringify(comparison, null, 2));
      return;
    }
    printReplayComparisonSummary(comparison);
    return;
  }

  if (options.replay) {
    const snapshot = await buildLandscapeReplaySnapshot({
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
      includeRuns: !options.compareCommunities,
    });
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    printReplaySummary(snapshot);
    return;
  }

  const snapshot = await buildLandscapeSnapshot({
    windowDays: options.windowDays,
    limit: options.limit,
    status: options.status,
    relationAxes: options.relationAxes,
    minSelectedCount: options.minSelectedCount,
    minFeedbackCount: options.minFeedbackCount,
  });

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printSummary(snapshot);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
