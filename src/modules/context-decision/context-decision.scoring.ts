import type {
  ContextDecisionConfidenceTrace,
  ContextDecisionEvidenceRole,
  ContextDecisionInput,
} from "../../shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";

export type DecisionEvidenceCandidate = {
  knowledge: KnowledgeSearchResult;
  role: ContextDecisionEvidenceRole;
};

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreKnowledge(item: KnowledgeSearchResult): number {
  const confidence = Number.isFinite(item.confidence) ? item.confidence : 70;
  const importance = Number.isFinite(item.importance) ? item.importance : 70;
  const dynamicScore = Number.isFinite(item.dynamicScore) ? item.dynamicScore : 0;
  const applicability = Number.isFinite(item.applicabilityScore) ? item.applicabilityScore : 0;
  const sourceStrength = item.hasSourceLinks || item.sourceRefs.length > 0 ? 8 : 0;
  return clamp(
    confidence * 0.32 + importance * 0.28 + dynamicScore * 0.16 + applicability + sourceStrength,
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
  const counterEvidence = params.evidence.filter((item) => item.role === "risk_warning");
  const preferences = params.evidence.filter((item) => item.role === "user_preference");
  const supportScore = clamp(
    average(selectedSupport.map((item) => scoreKnowledge(item.knowledge))),
  );
  const counterScore = clamp(
    average(counterEvidence.map((item) => scoreKnowledge(item.knowledge))),
  );
  const preferenceScore = clamp(average(preferences.map((item) => scoreKnowledge(item.knowledge))));
  const supportCoverage = params.coverage.filter((item) => item.queryRole === "support");
  const counterCoverage = params.coverage.filter((item) => item.queryRole === "counter_evidence");
  const coverageScore = clamp(
    average([
      supportCoverage.some((item) => item.hitCount > 0) ? 80 : 20,
      counterCoverage.length > 0 ? 70 : 30,
    ]),
  );
  const verificationScore = clamp(
    (params.input.verificationPlan ? 42 : 0) + (params.input.availableRollback ? 28 : 0) + 20,
  );
  const historicalFeedbackScore = clamp(50 - params.relatedBadSignalCount * 12);
  const forcedRules: string[] = [];

  if (params.input.knowledgePolicy === "required" && selectedSupport.length === 0) {
    forcedRules.push("knowledge_required_without_selected_support");
    const trace = {
      supportScore: 0,
      counterScore,
      preferenceScore,
      riskSignalScore: counterScore,
      coverageScore,
      verificationScore,
      historicalFeedbackScore,
      finalConfidence: 0,
      forcedRules,
    };
    return { confidence: 0, status: "degraded", trace };
  }

  if (selectedSupport.length === 0) {
    forcedRules.push("no_selected_support_evidence");
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
    riskSignalScore: counterScore,
    coverageScore,
    verificationScore,
    historicalFeedbackScore,
    finalConfidence: confidence,
    forcedRules,
  };
  return { confidence, status, trace };
}

export function resolveContextDecisionOutcome(params: {
  input: ContextDecisionInput;
  selectedAction: string | null;
  confidence: number;
}): "execute" | "revise_and_execute" | "escalate" {
  if (params.confidence === 0 && params.input.knowledgePolicy === "required") {
    return "escalate";
  }
  if (params.confidence < 35 && params.input.autonomyLevel === "low") {
    return "escalate";
  }
  if (
    params.selectedAction &&
    params.input.proposedAction &&
    params.selectedAction !== params.input.proposedAction
  ) {
    return "revise_and_execute";
  }
  return "execute";
}

export function evidenceWeightAtDecision(item: KnowledgeSearchResult): number {
  return scoreKnowledge(item);
}
