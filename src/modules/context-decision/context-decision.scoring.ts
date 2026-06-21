import type {
  ContextDecisionConfidenceTrace,
  ContextDecisionEvidenceRole,
  ContextDecisionEpisodePrecedent,
  ContextDecisionInput,
  ContextDecisionPrimaryEvidence,
  ContextDecisionRoleFit,
} from "../../shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import type { DecisionKnowledgeAnalysis } from "./context-decision.relevance.js";
import type { DecisionSignalBundle } from "./context-decision.signals.js";

export type DecisionEvidenceCandidate = {
  knowledge: KnowledgeSearchResult;
  role: ContextDecisionEvidenceRole;
  signals?: DecisionSignalBundle;
  analysis?: DecisionKnowledgeAnalysis;
};

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compileSignalAdjustment(
  role: ContextDecisionEvidenceRole,
  signals: DecisionSignalBundle | undefined,
): number {
  const compile = signals?.compile;
  if (!compile) return 0;
  const totalFeedback =
    compile.usedCount + compile.notUsedCount + compile.offTopicCount + compile.wrongCount;
  const notUsedRate = totalFeedback > 0 ? compile.notUsedCount / totalFeedback : 0;
  let adjustment = 0;
  if (role === "selected_support" || role === "user_preference") {
    if (compile.usedCount > 0 && compile.wrongCount === 0) adjustment += 6;
    if (compile.notUsedCount > 0 && notUsedRate >= 0.6) adjustment -= 8;
    if (compile.offTopicCount > 0) adjustment -= 12;
    if (compile.wrongCount > 0) adjustment -= 24;
    if (compile.suppressedCount > 0) adjustment -= 6;
    if (compile.rejectedByAgenticCount > 0) adjustment -= 8;
    if (compile.misleadingEvalCount > 0) adjustment -= 10;
  }
  if (role === "risk_warning" || role === "counter_evidence") {
    adjustment += Math.min(18, compile.wrongCount * 8 + compile.offTopicCount * 5);
  }
  return adjustment;
}

function landscapeSignalAdjustment(
  role: ContextDecisionEvidenceRole,
  signals: DecisionSignalBundle | undefined,
): number {
  const landscape = signals?.landscape;
  const community = signals?.community;
  if (!landscape && !community) return 0;
  let adjustment = 0;
  if (role === "selected_support" || role === "user_preference") {
    if (landscape?.classification === "strong_attractor") adjustment += 8;
    if (landscape?.classification === "useful_attractor") adjustment += 5;
    if (landscape?.classification === "negative_attractor_candidate") adjustment -= 26;
    if (landscape?.classification === "over_selected_not_used") adjustment -= 12;
    if (landscape?.classification === "dead_zone_stale") adjustment -= 10;
    if (landscape?.flags.includes("wrong_review_required")) adjustment -= 24;
    if (community?.health.dead) adjustment -= 30;
    if (community?.health.stale) adjustment -= 8;
    if (community?.health.thinEvidence) adjustment -= 8;
  }
  if (role === "risk_warning" || role === "counter_evidence") {
    if (landscape?.classification === "negative_attractor_candidate") adjustment += 16;
    if (landscape?.flags.includes("wrong_review_required")) adjustment += 14;
    adjustment += Math.min(12, Math.round((landscape?.negativeScore ?? 0) / 8));
  }
  return adjustment;
}

function scoreKnowledge(item: DecisionEvidenceCandidate): number {
  const knowledge = item.knowledge;
  const confidence = Number.isFinite(knowledge.confidence) ? knowledge.confidence : 70;
  const importance = Number.isFinite(knowledge.importance) ? knowledge.importance : 70;
  const dynamicScore = Number.isFinite(knowledge.dynamicScore) ? knowledge.dynamicScore : 0;
  const applicability = Number.isFinite(knowledge.applicabilityScore)
    ? knowledge.applicabilityScore
    : 0;
  const sourceStrength = knowledge.hasSourceLinks || knowledge.sourceRefs.length > 0 ? 8 : 0;
  return clamp(
    confidence * 0.32 +
      importance * 0.28 +
      dynamicScore * 0.16 +
      applicability +
      sourceStrength +
      compileSignalAdjustment(item.role, item.signals) +
      landscapeSignalAdjustment(item.role, item.signals),
  );
}

function strongestPrimaryEvidence(
  primaryEvidence: ContextDecisionPrimaryEvidence[],
): ContextDecisionPrimaryEvidence["strength"] | "none" {
  const order: Array<ContextDecisionPrimaryEvidence["strength"]> = [
    "verified",
    "observed",
    "claimed",
    "inferred",
  ];
  for (const strength of order) {
    if (primaryEvidence.some((item) => item.strength === strength)) return strength;
  }
  return "none";
}

function roleFitPass(role: ContextDecisionEvidenceRole, roleFit: ContextDecisionRoleFit): boolean {
  if (role === "selected_support" || role === "user_preference") {
    return roleFit.classification === "direct_support";
  }
  if (role === "risk_warning") {
    return (
      roleFit.classification === "direct_risk" ||
      roleFit.classification === "verification_requirement"
    );
  }
  if (role === "counter_evidence" || role === "rejected_alternative") {
    return (
      roleFit.classification === "counter_evidence" || roleFit.classification === "direct_risk"
    );
  }
  return false;
}

export function scoreContextDecision(params: {
  input: ContextDecisionInput;
  evidence: DecisionEvidenceCandidate[];
  coverage: Array<{ queryRole: string; hitCount: number }>;
  relatedBadSignalCount: number;
  primaryEvidence?: ContextDecisionPrimaryEvidence[];
  episodePrecedents?: ContextDecisionEpisodePrecedent[];
}): {
  confidence: number;
  status: "completed" | "degraded";
  trace: ContextDecisionConfidenceTrace;
} {
  const primaryEvidence = params.primaryEvidence ?? [];
  const episodePrecedents = params.episodePrecedents ?? [];
  const selectedSupport = params.evidence.filter((item) => item.role === "selected_support");
  const counterEvidence = params.evidence.filter(
    (item) => item.role === "counter_evidence" || item.role === "rejected_alternative",
  );
  const riskWarnings = params.evidence.filter((item) => item.role === "risk_warning");
  const preferences = params.evidence.filter((item) => item.role === "user_preference");
  const supportScore = clamp(average(selectedSupport.map((item) => scoreKnowledge(item))));
  const counterScore = clamp(average(counterEvidence.map((item) => scoreKnowledge(item))));
  const riskSignalScore = clamp(average(riskWarnings.map((item) => scoreKnowledge(item))));
  const preferenceScore = clamp(average(preferences.map((item) => scoreKnowledge(item))));
  const supportCoverage = params.coverage.filter((item) => item.queryRole === "support");
  const counterCoverage = params.coverage.filter((item) => item.queryRole === "counter_evidence");
  const coverageScore = clamp(
    average([
      supportCoverage.some((item) => item.hitCount > 0) ? 80 : 20,
      counterCoverage.length > 0 ? 70 : 30,
    ]),
  );
  const verificationScore = 50;
  const historicalFeedbackScore = clamp(50 - params.relatedBadSignalCount * 12);
  const forcedRules: string[] = [];

  if (selectedSupport.length === 0) {
    forcedRules.push("no_selected_support_evidence");
  }

  if (riskWarnings.length > 0) {
    forcedRules.push("risk_warnings_present");
  }

  if (counterEvidence.length > 0) {
    forcedRules.push("counter_evidence_present");
  }

  const riskPenalty = Math.min(18, counterScore * 0.18);
  const uncappedConfidence = clamp(
    supportScore * 0.45 +
      preferenceScore * 0.12 +
      coverageScore * 0.18 +
      verificationScore * 0.15 +
      historicalFeedbackScore * 0.1 -
      riskPenalty,
  );
  const status = selectedSupport.length === 0 || coverageScore < 45 ? "degraded" : "completed";
  const topicalScores = params.evidence
    .map((item) => item.analysis?.topicalRelevanceScore)
    .filter((item): item is number => typeof item === "number");
  const roleFits = params.evidence
    .map((item) => ({ role: item.role, roleFit: item.analysis?.roleFit }))
    .filter(
      (item): item is { role: ContextDecisionEvidenceRole; roleFit: ContextDecisionRoleFit } =>
        Boolean(item.roleFit),
    );
  const directKnowledgeCount = params.evidence.filter((item) => {
    const analysis = item.analysis;
    if (!analysis || analysis.topicalRelevanceScore < 70) return false;
    return roleFitPass(item.role, analysis.roleFit);
  }).length;
  const strongPrimaryCount = primaryEvidence.filter(
    (item) => item.strength === "verified" || item.strength === "observed",
  ).length;
  const directEvidenceRatio = clamp(
    ((directKnowledgeCount + strongPrimaryCount) /
      Math.max(1, params.evidence.length + primaryEvidence.length)) *
      100,
  );
  const primaryEvidenceStrength = strongestPrimaryEvidence(primaryEvidence);
  const roleFitPassRate =
    roleFits.length === 0
      ? 0
      : clamp(
          (roleFits.filter((item) => roleFitPass(item.role, item.roleFit)).length /
            roleFits.length) *
            100,
        );
  const topicalRelevanceAverage = clamp(average(topicalScores));
  const episodePrecedentRisk = episodePrecedents.filter(
    (item) => item.usedFor === "risk_cap",
  ).length;
  const confidenceCaps: NonNullable<ContextDecisionConfidenceTrace["confidenceCaps"]> = [];
  const addCap = (key: string, cap: number, reason: string) => {
    confidenceCaps.push({ key, cap, reason });
  };
  const hasEvidenceDirectnessContext =
    primaryEvidence.length > 0 || params.evidence.some((item) => item.analysis);
  if (
    primaryEvidence.length > 0 &&
    primaryEvidence.every((item) => item.strength === "claimed" || item.strength === "inferred")
  ) {
    addCap(
      "primary_evidence_claimed_or_inferred",
      55,
      "Primary evidence is missing or only claimed/inferred.",
    );
  }
  if (hasEvidenceDirectnessContext && directEvidenceRatio < 30) {
    addCap("low_direct_evidence_ratio", 45, "Direct evidence ratio is below 30%.");
  }
  if (roleFits.length > 0 && roleFitPassRate < 50) {
    addCap("low_role_fit_pass_rate", 60, "Role fit pass rate is below 50%.");
  }
  if (episodePrecedentRisk > 0) {
    addCap(
      "failure_episode_precedent",
      65,
      "High-relevance failure or mixed EpisodeCard precedent is present.",
    );
  }
  if (status === "degraded") {
    addCap("degraded_status", 70, "Decision scoring status is degraded.");
  }
  const confidenceCap = confidenceCaps.reduce<number | null>(
    (current, item) => (current === null ? item.cap : Math.min(current, item.cap)),
    null,
  );
  const confidence =
    confidenceCap === null ? uncappedConfidence : Math.min(uncappedConfidence, confidenceCap);
  const trace = {
    supportScore,
    counterScore,
    preferenceScore,
    riskSignalScore,
    coverageScore,
    verificationScore,
    historicalFeedbackScore,
    finalConfidence: confidence,
    forcedRules,
    primaryEvidence,
    episodePrecedents,
    directEvidenceRatio,
    primaryEvidenceStrength,
    episodePrecedentRisk,
    topicalRelevanceAverage,
    roleFitPassRate,
    confidenceCaps,
  };
  return { confidence, status, trace };
}

export function resolveContextDecisionOutcome(params: {
  selectedAction: string | null;
  confidence: number;
}): "execute" | "revise_and_execute" | "escalate" {
  if (params.confidence < 35) {
    return "escalate";
  }
  return "execute";
}

export function evidenceWeightAtDecision(
  item: KnowledgeSearchResult,
  role: ContextDecisionEvidenceRole = "selected_support",
  signals?: DecisionSignalBundle,
): number {
  return scoreKnowledge({ knowledge: item, role, signals });
}
