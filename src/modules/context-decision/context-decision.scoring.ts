import type {
  ContextDecisionConfidenceTrace,
  ContextDecisionEvidenceRole,
  ContextDecisionInput,
} from "../../shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import type { DecisionSignalBundle } from "./context-decision.signals.js";

export type DecisionEvidenceCandidate = {
  knowledge: KnowledgeSearchResult;
  role: ContextDecisionEvidenceRole;
  signals?: DecisionSignalBundle;
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

export function scoreContextDecision(params: {
  input: ContextDecisionInput;
  evidence: DecisionEvidenceCandidate[];
  coverage: Array<{ queryRole: string; hitCount: number }>;
  relatedBadSignalCount: number;
}): {
  confidence: number;
  status: "completed" | "degraded";
  trace: ContextDecisionConfidenceTrace;
} {
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
  const confidence = clamp(
    supportScore * 0.45 +
      preferenceScore * 0.12 +
      coverageScore * 0.18 +
      verificationScore * 0.15 +
      historicalFeedbackScore * 0.1 -
      riskPenalty,
  );
  const status = selectedSupport.length === 0 || coverageScore < 45 ? "degraded" : "completed";
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
