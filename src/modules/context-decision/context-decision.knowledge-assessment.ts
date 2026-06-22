import type {
  ContextDecisionCoverageQueryRole,
  ContextDecisionKnowledgeAssessment,
  ContextDecisionRetrievalMethod,
} from "../../shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import type { DecisionEvidenceCandidate } from "./context-decision.scoring.js";

export type ContextDecisionCandidateTrace = {
  knowledgeId: string;
  chunkId: string | null;
  role: ContextDecisionCoverageQueryRole;
  retrievalMethod: ContextDecisionRetrievalMethod;
  vectorStatus?: "available" | "unavailable";
  vectorSimilarity: number | null;
  keywordScore: number;
  facetScore: number;
  sourceQualityScore: number;
  feedbackSignalScore: number;
  finalCandidateScore: number;
  selected: boolean;
  selectionStage?:
    | "retrieved"
    | "relevance_filtered"
    | "role_fit_classified"
    | "selected"
    | "suppressed";
  topicalRelevanceScore?: number;
  topicalRelevanceReason?: string;
  roleFit?: import("../../shared/schemas/context-decision.schema.js").ContextDecisionRoleFit;
  selectionReason: string | null;
  rejectionReason: string | null;
};

export type ContextDecisionCoverageAssessmentInput = {
  queryRole: ContextDecisionCoverageQueryRole;
  hits: KnowledgeSearchResult[];
  selectedKnowledgeIds: string[];
  duplicateSuppressedKnowledgeIds?: string[];
};

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sourceQuality(item: KnowledgeSearchResult): number {
  if (item.hasSourceLinks) return 90;
  if (item.sourceRefs.length > 0) return 75;
  return 45;
}

function retrievalMethod(item: KnowledgeSearchResult): ContextDecisionRetrievalMethod {
  const hasKeyword = (Number(item.score) || 0) > 0;
  const hasFacet = item.applicabilityScore > 0;
  if (hasKeyword && hasFacet) return "hybrid";
  if (hasFacet) return "facet";
  return "keyword";
}

function finalCandidateScore(item: KnowledgeSearchResult): number {
  return clamp(
    (Number(item.score) || 0) * 32 +
      item.applicabilityScore * 0.38 +
      sourceQuality(item) * 0.16 +
      item.confidence * 0.18 +
      item.importance * 0.12 +
      item.dynamicScore * 0.08,
  );
}

export function buildContextDecisionCandidateTraces(
  coverage: ContextDecisionCoverageAssessmentInput[],
): ContextDecisionCandidateTrace[] {
  return coverage.flatMap((entry) =>
    entry.hits.map((item, index) => {
      const selected = entry.selectedKnowledgeIds.includes(item.id);
      const duplicateSuppressed = entry.duplicateSuppressedKnowledgeIds?.includes(item.id) ?? false;
      const method = retrievalMethod(item);
      return {
        knowledgeId: item.id,
        chunkId: null,
        role: entry.queryRole,
        retrievalMethod: method,
        vectorStatus: "unavailable",
        vectorSimilarity: null,
        keywordScore: clamp((Number(item.score) || 0) * 100),
        facetScore: clamp(item.applicabilityScore),
        sourceQualityScore: sourceQuality(item),
        feedbackSignalScore: clamp(50 + item.dynamicScore),
        finalCandidateScore: finalCandidateScore(item),
        selected,
        selectionReason: selected ? `top ${entry.queryRole} candidate` : null,
        rejectionReason: selected
          ? null
          : duplicateSuppressed
            ? `duplicate suppressed by stronger decision role for ${entry.queryRole}`
            : `ranked below selected ${entry.queryRole} candidates`,
      };
    }),
  );
}

function roleSelected(
  evidence: DecisionEvidenceCandidate[],
  role: DecisionEvidenceCandidate["role"],
): KnowledgeSearchResult[] {
  return evidence.filter((item) => item.role === role).map((item) => item.knowledge);
}

function roleAttempted(
  coverage: ContextDecisionCoverageAssessmentInput[],
  role: ContextDecisionCoverageQueryRole,
): boolean {
  return coverage.some((item) => item.queryRole === role);
}

function strength(items: KnowledgeSearchResult[]): number {
  return clamp(average(items.map(finalCandidateScore)));
}

function uniqueRetrievalMethods(
  traces: ContextDecisionCandidateTrace[],
): ContextDecisionKnowledgeAssessment["retrievalMethods"] {
  const methods = new Set<"vector" | "keyword" | "hybrid">();
  for (const trace of traces) {
    if (trace.retrievalMethod === "vector") methods.add("vector");
    else if (trace.retrievalMethod === "hybrid") methods.add("hybrid");
    else methods.add("keyword");
  }
  return Array.from(methods);
}

function metric(
  key: NonNullable<ContextDecisionKnowledgeAssessment["meaningfulMetrics"]>[number]["key"],
  label: string,
  value: number,
): NonNullable<ContextDecisionKnowledgeAssessment["meaningfulMetrics"]>[number] {
  return { key, label, value };
}

export function assessContextDecisionKnowledge(params: {
  evidence: DecisionEvidenceCandidate[];
  coverage: ContextDecisionCoverageAssessmentInput[];
  candidateTraces: ContextDecisionCandidateTrace[];
  relatedBadSignalCount: number;
}): ContextDecisionKnowledgeAssessment {
  const support = roleSelected(params.evidence, "selected_support");
  const preferences = roleSelected(params.evidence, "user_preference");
  const risks = roleSelected(params.evidence, "risk_warning");
  const selectedCounterEvidence = roleSelected(params.evidence, "counter_evidence");
  const supportStrength = strength(support);
  const preferenceAlignment = strength(preferences);
  const riskStrength = strength(risks);
  const selectedIds = new Set(params.evidence.map((item) => item.knowledge.id));
  const counterEvidenceStrength = strength(selectedCounterEvidence.slice(0, 3));
  const selectedTraces = params.candidateTraces.filter((trace) =>
    selectedIds.has(trace.knowledgeId),
  );
  const attemptedRoles = new Set(params.coverage.map((item) => item.queryRole));
  const roleCoverage = attemptedRoles.size / 6;
  const hitCoverage = Math.min(
    1,
    params.coverage.filter((item) => item.hits.length > 0).length / 6,
  );
  const selectedCoverage = Math.min(1, selectedIds.size / 4);
  const knowledgeCoverage = clamp(
    (roleCoverage * 0.35 + hitCoverage * 0.35 + selectedCoverage * 0.3) * 100,
  );
  const applicabilityScore = clamp(average(selectedTraces.map((trace) => trace.facetScore)));
  const sourceQualityScore = clamp(
    average(selectedTraces.map((trace) => trace.sourceQualityScore)),
  );
  const conflictScore = clamp(counterEvidenceStrength * 0.7 + params.relatedBadSignalCount * 12);
  const consensusScore = clamp(supportStrength - conflictScore * 0.35 + preferenceAlignment * 0.15);
  const outOfDistributionScore = clamp(
    100 - knowledgeCoverage * 0.55 - applicabilityScore * 0.25 - supportStrength * 0.2,
  );
  const hasUsableEvidence =
    support.length > 0 ||
    preferences.length > 0 ||
    risks.length > 0 ||
    selectedCounterEvidence.length > 0;
  const missingRequiredCoverage =
    !roleAttempted(params.coverage, "counter_evidence") ||
    !roleAttempted(params.coverage, "risk") ||
    !roleAttempted(params.coverage, "alternative") ||
    !roleAttempted(params.coverage, "verification");
  const status: ContextDecisionKnowledgeAssessment["status"] = !hasUsableEvidence
    ? "no_evidence"
    : missingRequiredCoverage || knowledgeCoverage < 55
      ? "weak_coverage"
      : "evaluable";
  const recommendedDirection: ContextDecisionKnowledgeAssessment["recommendedDirection"] =
    status === "no_evidence"
      ? "escalate"
      : riskStrength >= 90
        ? "reject"
        : conflictScore >= 42 || riskStrength >= 70 || outOfDistributionScore >= 70
          ? "revise_and_execute"
          : "execute";
  const meaningfulMetrics: NonNullable<ContextDecisionKnowledgeAssessment["meaningfulMetrics"]> = [
    metric("knowledgeCoverage", "Coverage", knowledgeCoverage),
  ];
  if (support.length > 0) {
    meaningfulMetrics.push(metric("supportStrength", "Support", supportStrength));
  }
  if (selectedCounterEvidence.length > 0) {
    meaningfulMetrics.push(metric("counterEvidenceStrength", "Counter", counterEvidenceStrength));
  }
  if (risks.length > 0) {
    meaningfulMetrics.push(metric("riskStrength", "Risk", riskStrength));
  }
  if (preferences.length > 0) {
    meaningfulMetrics.push(metric("preferenceAlignment", "Preference", preferenceAlignment));
  }
  if (selectedTraces.some((trace) => trace.facetScore > 0)) {
    meaningfulMetrics.push(metric("applicabilityScore", "Applicability", applicabilityScore));
  }
  if (support.length > 0 && selectedCounterEvidence.length > 0) {
    meaningfulMetrics.push(metric("consensusScore", "Consensus", consensusScore));
    meaningfulMetrics.push(metric("conflictScore", "Conflict", conflictScore));
  }
  if (outOfDistributionScore >= 55) {
    meaningfulMetrics.push(
      metric("outOfDistributionScore", "Out of Dist.", outOfDistributionScore),
    );
  }

  return {
    status,
    recommendedDirection,
    knowledgeCoverage,
    supportStrength,
    counterEvidenceStrength,
    riskStrength,
    preferenceAlignment,
    applicabilityScore,
    consensusScore,
    conflictScore,
    sourceQualityScore,
    outOfDistributionScore,
    retrievalMethods: uniqueRetrievalMethods(params.candidateTraces),
    meaningfulMetrics,
    reason: !hasUsableEvidence
      ? "No selected support or preference Knowledge was found."
      : status === "weak_coverage"
        ? "Knowledge evidence exists, but retrieval coverage is not strong enough across all decision roles."
        : "Knowledge evidence covers support, risks, preferences, verification, and alternatives.",
  };
}
