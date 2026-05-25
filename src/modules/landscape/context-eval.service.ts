import { buildLandscapeReplayComparison } from "./landscape-replay-comparison.service.js";
import type {
  BuildLandscapeReplayComparisonInput,
  LandscapeReplayComparisonRun,
  LandscapeRunStatusFilter,
} from "./landscape-replay.types.js";

const HIGH_CHURN_REPLACEMENT_RATE = 0.5;

type ContextEvalSource = {
  mode: "from_replay";
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  readOnly: true;
  cacheBypassed: boolean;
};

type ContextEvalScore = {
  value: number;
  formula: string;
  numerator: number;
  denominator: number;
};

type ContextEvalScores = {
  retentionScore: ContextEvalScore;
  churnScore: ContextEvalScore;
  repulsionScore: ContextEvalScore;
  reachabilityScore: ContextEvalScore;
  stabilityScore: ContextEvalScore;
};

type ContextEvalRunSummary = {
  runId: string;
  createdAt: string;
  comparison: LandscapeReplayComparisonRun["comparison"];
  overlapRate: number;
  replacementRate: number;
  usedBaselineLostCount: number;
  negativeReselectedCount: number;
  currentDegradedReasons: string[];
  goal: string;
};

type ContextEvalSummary = {
  status: "healthy" | "needs_review" | "no_data";
  comparedRunCount: number;
  averageOverlapRate: number;
  promotionGateMode: "normal" | "review_required";
  reason: string;
};

type ContextEvalMetrics = {
  replayRunCount: number;
  comparedRunCount: number;
  usedBaselineRetainedItemCount: number;
  usedBaselineLostItemCount: number;
  usedBaselineTotalItemCount: number;
  averageReplacementRate: number;
  highChurnRunCount: number;
  negativeBaselineItemCount: number;
  negativeReselectedItemCount: number;
  noCurrentMatchRunCount: number;
  unstableRunCount: number;
  degradedCurrentRunCount: number;
  noContentRunCount: number;
};

export type ContextEvalReport = {
  generatedAt: string;
  source: ContextEvalSource;
  summary: ContextEvalSummary;
  metrics: ContextEvalMetrics;
  scores: ContextEvalScores;
  riskyRuns: ContextEvalRunSummary[];
  usedBaselineLost: ContextEvalRunSummary[];
  highChurnRuns: ContextEvalRunSummary[];
  noCurrentMatchRuns: ContextEvalRunSummary[];
  recommendedNextAction: {
    strategy: "observe_only" | "retain_used_baseline" | "repel_negative_candidates" | "diversity_exploration";
    candidateRunCount: number;
    reason: string;
    productionEnabled: false;
  };
  replayComparison: {
    comparisonCounts: {
      stable: number;
      drifted: number;
      lost_baseline: number;
      new_only: number;
      no_current_match: number;
    };
    usedBaselineLostItemCount: number;
    currentNoMatchRunCount: number;
    averageOverlapRate: number;
    promotionGateMode: "normal" | "review_required";
  };
};

export type BuildContextEvalReportInput = {
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  maxRiskyRuns?: number;
};

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

function includesNoContent(degradedReasons: string[]): boolean {
  return degradedReasons.some((reason) => reason.toUpperCase().includes("NO_CONTENT"));
}

function negativeReselectedCount(run: LandscapeReplayComparisonRun): number {
  const baselineNegativeIds = new Set([
    ...run.offTopicBaselineKnowledgeIds,
    ...run.wrongBaselineKnowledgeIds,
  ]);
  if (baselineNegativeIds.size === 0) return 0;
  return run.currentRetrievedKnowledgeIds.filter((id) => baselineNegativeIds.has(id)).length;
}

function runSummary(run: LandscapeReplayComparisonRun): ContextEvalRunSummary {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    comparison: run.comparison,
    overlapRate: run.overlapRate,
    replacementRate: run.replacementRate,
    usedBaselineLostCount: run.usedBaselineLostKnowledgeIds.length,
    negativeReselectedCount: negativeReselectedCount(run),
    currentDegradedReasons: run.currentDegradedReasons,
    goal: run.goal,
  };
}

async function buildReplayComparisonReadOnly(
  input: BuildLandscapeReplayComparisonInput,
): ReturnType<typeof buildLandscapeReplayComparison> {
  const previous = process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED;
  process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "false";
  try {
    return await buildLandscapeReplayComparison(input);
  } finally {
    if (previous === undefined) {
      delete process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED;
    } else {
      process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = previous;
    }
  }
}

export async function buildContextEvalReportFromReplay(
  input: BuildContextEvalReportInput,
): Promise<ContextEvalReport> {
  const comparison = await buildReplayComparisonReadOnly({
    windowDays: input.windowDays,
    limit: input.limit,
    runStatus: input.runStatus,
    currentLimit: input.currentLimit,
    includeRuns: true,
  });

  const runs = comparison.runs;
  const comparedRunCount = runs.length;
  const usedBaselineRetainedItemCount = runs.reduce(
    (sum, run) => sum + run.usedBaselineRetainedKnowledgeIds.length,
    0,
  );
  const usedBaselineLostItemCount = runs.reduce(
    (sum, run) => sum + run.usedBaselineLostKnowledgeIds.length,
    0,
  );
  const usedBaselineTotalItemCount = usedBaselineRetainedItemCount + usedBaselineLostItemCount;
  const negativeBaselineItemCount = runs.reduce(
    (sum, run) => sum + run.offTopicBaselineKnowledgeIds.length + run.wrongBaselineKnowledgeIds.length,
    0,
  );
  const negativeReselectedItemCount = runs.reduce((sum, run) => sum + negativeReselectedCount(run), 0);
  const degradedCurrentRunCount = runs.filter((run) => run.currentDegradedReasons.length > 0).length;
  const noContentRunCount = runs.filter((run) => includesNoContent(run.currentDegradedReasons)).length;
  const unstableRunCount = runs.filter(
    (run) => run.currentDegradedReasons.length > 0 || run.comparison === "no_current_match",
  ).length;

  const retentionScore = clamp01(rate(usedBaselineRetainedItemCount, usedBaselineTotalItemCount));
  const churnScore = clamp01(1 - comparison.scoreTuning.averageReplacementRate);
  const repulsionScore =
    negativeBaselineItemCount === 0
      ? 1
      : clamp01(1 - negativeReselectedItemCount / negativeBaselineItemCount);
  const reachabilityScore = clamp01(
    1 - rate(comparison.currentNoMatchRunCount, Math.max(1, comparedRunCount)),
  );
  const stabilityScore = clamp01(1 - rate(unstableRunCount, Math.max(1, comparedRunCount)));

  const maxRiskyRuns = input.maxRiskyRuns ?? 20;
  const riskyRuns = runs
    .filter(
      (run) =>
        run.comparison === "lost_baseline" ||
        run.comparison === "no_current_match" ||
        run.usedBaselineLostKnowledgeIds.length > 0 ||
        negativeReselectedCount(run) > 0 ||
        run.currentDegradedReasons.length > 0,
    )
    .map(runSummary)
    .slice(0, maxRiskyRuns);

  const usedBaselineLost = runs
    .filter((run) => run.usedBaselineLostKnowledgeIds.length > 0)
    .map(runSummary)
    .slice(0, maxRiskyRuns);

  const highChurnRuns = runs
    .filter(
      (run) =>
        run.replacementRate >= HIGH_CHURN_REPLACEMENT_RATE && run.newlyRetrievedKnowledgeIds.length > 0,
    )
    .map(runSummary)
    .slice(0, maxRiskyRuns);

  const noCurrentMatchRuns = runs
    .filter((run) => run.comparison === "no_current_match" || run.currentRetrievedKnowledgeIds.length === 0)
    .map(runSummary)
    .slice(0, maxRiskyRuns);

  let summary: ContextEvalSummary = {
    status: "healthy",
    comparedRunCount,
    averageOverlapRate: comparison.averageOverlapRate,
    promotionGateMode: comparison.promotionGateSummary.gateMode,
    reason: "Replay comparison is stable enough for observe-only iteration.",
  };

  if (comparedRunCount === 0) {
    summary = {
      status: "no_data",
      comparedRunCount,
      averageOverlapRate: 0,
      promotionGateMode: comparison.promotionGateSummary.gateMode,
      reason: "Replay corpus has no comparable runs in the selected window.",
    };
  } else if (
    comparison.promotionGateSummary.gateMode === "review_required" ||
    retentionScore < 0.8 ||
    stabilityScore < 0.8
  ) {
    summary = {
      status: "needs_review",
      comparedRunCount,
      averageOverlapRate: comparison.averageOverlapRate,
      promotionGateMode: comparison.promotionGateSummary.gateMode,
      reason: "Baseline retention or stability regressed; review before ranking changes.",
    };
  }

  return {
    generatedAt: comparison.generatedAt,
    source: {
      mode: "from_replay",
      windowDays: input.windowDays,
      limit: input.limit,
      runStatus: input.runStatus,
      currentLimit: input.currentLimit,
      readOnly: true,
      cacheBypassed: true,
    },
    summary,
    metrics: {
      replayRunCount: comparison.replayRunCount,
      comparedRunCount,
      usedBaselineRetainedItemCount,
      usedBaselineLostItemCount,
      usedBaselineTotalItemCount,
      averageReplacementRate: comparison.scoreTuning.averageReplacementRate,
      highChurnRunCount: comparison.scoreTuning.highChurnRunCount,
      negativeBaselineItemCount,
      negativeReselectedItemCount,
      noCurrentMatchRunCount: comparison.currentNoMatchRunCount,
      unstableRunCount,
      degradedCurrentRunCount,
      noContentRunCount,
    },
    scores: {
      retentionScore: {
        value: retentionScore,
        formula: "1 - usedBaselineLost / max(usedBaselineRetained + usedBaselineLost, 1)",
        numerator: usedBaselineTotalItemCount === 0 ? 1 : usedBaselineRetainedItemCount,
        denominator: Math.max(1, usedBaselineTotalItemCount),
      },
      churnScore: {
        value: churnScore,
        formula: "1 - averageReplacementRate",
        numerator: 1 - comparison.scoreTuning.averageReplacementRate,
        denominator: 1,
      },
      repulsionScore: {
        value: repulsionScore,
        formula: "1 - negativeReselected / max(negativeBaseline, 1)",
        numerator:
          negativeBaselineItemCount === 0
            ? 1
            : Math.max(0, negativeBaselineItemCount - negativeReselectedItemCount),
        denominator: Math.max(1, negativeBaselineItemCount),
      },
      reachabilityScore: {
        value: reachabilityScore,
        formula: "1 - noCurrentMatchRuns / max(comparedRuns, 1)",
        numerator: Math.max(0, comparedRunCount - comparison.currentNoMatchRunCount),
        denominator: Math.max(1, comparedRunCount),
      },
      stabilityScore: {
        value: stabilityScore,
        formula: "1 - unstableRuns / max(comparedRuns, 1)",
        numerator: Math.max(0, comparedRunCount - unstableRunCount),
        denominator: Math.max(1, comparedRunCount),
      },
    },
    riskyRuns,
    usedBaselineLost,
    highChurnRuns,
    noCurrentMatchRuns,
    recommendedNextAction: {
      strategy: comparison.compileInterventionPlan.strategy,
      candidateRunCount: comparison.compileInterventionPlan.candidateRunCount,
      reason: comparison.compileInterventionPlan.reason,
      productionEnabled: comparison.compileInterventionPlan.productionEnabled,
    },
    replayComparison: {
      comparisonCounts: comparison.comparisonCounts,
      usedBaselineLostItemCount: comparison.usedBaselineLostItemCount,
      currentNoMatchRunCount: comparison.currentNoMatchRunCount,
      averageOverlapRate: comparison.averageOverlapRate,
      promotionGateMode: comparison.promotionGateSummary.gateMode,
    },
  };
}
