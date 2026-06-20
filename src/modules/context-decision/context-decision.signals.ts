import type { ContextDecisionConfidenceTrace } from "../../shared/schemas/context-decision.schema.js";

export type DecisionSignalBundle = {
  compile?: {
    compileSelectCount: number;
    recentSelectedCount: number;
    usedCount: number;
    notUsedCount: number;
    offTopicCount: number;
    wrongCount: number;
    suppressedCount: number;
    rejectedByAgenticCount: number;
    misleadingEvalCount: number;
  };
  community?: {
    communityKey: string | null;
    communityLabel: string | null;
    communityRank: number | null;
    sourceRefDensity: number | null;
    compileSelectCount: number;
    health: {
      dead: boolean;
      stale: boolean;
      thinEvidence: boolean;
    };
  };
  landscape?: {
    classification: string | null;
    confidence: "low" | "medium" | "high" | null;
    attractorScore: number;
    negativeScore: number;
    reachabilityRiskScore: number;
    usedRate: number;
    notUsedRate: number;
    offTopicRate: number;
    wrongRate: number;
    flags: string[];
  };
};

export type DecisionSignalLoadResult = {
  status: "complete" | "partial" | "failed";
  bundles: Map<string, DecisionSignalBundle>;
  reason: string;
};

export function emptyDecisionSignalBundle(): DecisionSignalBundle {
  return {};
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function summarizeDecisionSignals(
  result: DecisionSignalLoadResult,
): NonNullable<ContextDecisionConfidenceTrace["signalStatus"]> {
  const bundles = Array.from(result.bundles.values());
  return {
    status: result.status,
    evidenceCount: bundles.length,
    compileSignalCount: bundles.filter((bundle) => Boolean(bundle.compile)).length,
    communitySignalCount: bundles.filter((bundle) => Boolean(bundle.community?.communityKey))
      .length,
    landscapeSignalCount: bundles.filter((bundle) => Boolean(bundle.landscape?.classification))
      .length,
    reason: result.reason,
  };
}

export function buildDecisionSignalAssessmentSummary(result: DecisionSignalLoadResult) {
  const bundles = Array.from(result.bundles.values());
  const compileWrongCount = sum(bundles.map((bundle) => bundle.compile?.wrongCount ?? 0));
  const compileOffTopicCount = sum(bundles.map((bundle) => bundle.compile?.offTopicCount ?? 0));
  const negativeAttractorCount = bundles.filter(
    (bundle) => bundle.landscape?.classification === "negative_attractor_candidate",
  ).length;
  const strongAttractorCount = bundles.filter(
    (bundle) =>
      bundle.landscape?.classification === "strong_attractor" ||
      bundle.landscape?.classification === "useful_attractor",
  ).length;
  const cappedCommunityCount = bundles.filter(
    (bundle) => bundle.community?.health.stale || bundle.community?.health.thinEvidence,
  ).length;
  return {
    status: result.status,
    compileWrongCount,
    compileOffTopicCount,
    negativeAttractorCount,
    strongAttractorCount,
    cappedCommunityCount,
    reason: result.reason,
  };
}

export function signalTracePayload(result: DecisionSignalLoadResult): {
  compileSignals: Record<string, unknown>;
  communitySignals: Record<string, unknown>;
  landscapeSignals: Record<string, unknown>;
} {
  const entries = Array.from(result.bundles.entries());
  return {
    compileSignals: Object.fromEntries(
      entries
        .filter(([, bundle]) => bundle.compile)
        .map(([knowledgeId, bundle]) => [knowledgeId, bundle.compile]),
    ),
    communitySignals: Object.fromEntries(
      entries
        .filter(([, bundle]) => bundle.community)
        .map(([knowledgeId, bundle]) => [knowledgeId, bundle.community]),
    ),
    landscapeSignals: Object.fromEntries(
      entries
        .filter(([, bundle]) => bundle.landscape)
        .map(([knowledgeId, bundle]) => [knowledgeId, bundle.landscape]),
    ),
  };
}
