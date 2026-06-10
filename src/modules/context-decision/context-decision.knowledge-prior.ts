import type { ContextDecisionKnowledgePrior } from "../../shared/schemas/context-decision.schema.js";
import type { ContextDecisionCandidateTrace } from "./context-decision.knowledge-assessment.js";
import type { DecisionEvidenceCandidate } from "./context-decision.scoring.js";

function roleLabel(role: string): string {
  if (role === "selected_support") return "support";
  if (role === "user_preference") return "preference";
  if (role === "risk_warning") return "risk";
  if (role === "rejected_alternative") return "alternative";
  return role;
}

function topTitles(items: DecisionEvidenceCandidate[], limit: number): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const item of items) {
    const title = item.knowledge.title.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    titles.push(`${roleLabel(item.role)}: ${title}`);
    if (titles.length >= limit) break;
  }
  return titles;
}

function topCandidateSignals(traces: ContextDecisionCandidateTrace[], limit: number): string[] {
  return [...traces]
    .sort((a, b) => b.finalCandidateScore - a.finalCandidateScore)
    .slice(0, limit)
    .map(
      (trace) =>
        `${trace.role} via ${trace.retrievalMethod}: score ${trace.finalCandidateScore}, ${trace.selected ? "selected" : "not selected"}`,
    );
}

export function buildContextDecisionKnowledgePrior(params: {
  evidence: DecisionEvidenceCandidate[];
  candidateTraces: ContextDecisionCandidateTrace[];
}): ContextDecisionKnowledgePrior {
  const selectedEvidence = params.evidence.filter(
    (item) => item.role === "selected_support" || item.role === "user_preference",
  );
  const riskEvidence = params.evidence.filter((item) => item.role === "risk_warning");
  const alternativeEvidence = params.evidence.filter(
    (item) => item.role === "rejected_alternative",
  );
  const signals = [
    ...topTitles(selectedEvidence, 4),
    ...topCandidateSignals(
      params.candidateTraces.filter((trace) => trace.selected),
      4,
    ),
  ].slice(0, 8);
  const cautions = [...topTitles(riskEvidence, 3), ...topTitles(alternativeEvidence, 2)].slice(
    0,
    5,
  );
  const status: ContextDecisionKnowledgePrior["status"] =
    selectedEvidence.length > 0
      ? "available"
      : params.candidateTraces.length > 0
        ? "limited"
        : "unavailable";

  return {
    status,
    source: "retrieval_prior_v1",
    referenceOnly: true,
    notUsedForScoring: true,
    evidenceCount: params.evidence.length,
    candidateCount: params.candidateTraces.length,
    summary:
      status === "available"
        ? "Knowledge prior is available as an LLM reference note from retrieved Knowledge patterns."
        : status === "limited"
          ? "Knowledge prior has candidate patterns, but no selected support/preference evidence."
          : "Knowledge prior is unavailable because no usable Knowledge candidates were retrieved.",
    signals,
    cautions,
  };
}
