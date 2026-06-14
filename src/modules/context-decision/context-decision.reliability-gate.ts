import type {
  ContextDecisionKnowledgeAssessment,
  ContextDecisionReliabilityGate,
  ContextDecisionValue,
} from "../../shared/schemas/context-decision.schema.js";
import type { DecisionEvidenceCandidate } from "./context-decision.scoring.js";

export type ContextDecisionJudgmentLike = {
  decision: ContextDecisionValue;
  confidence: number;
  mandate: string;
  selectedAction: string | null;
  rejectedActions: string[];
  reasoningSummary: string;
};

export type RelatedDecisionBadSignalSummary = {
  count: number;
  strongCount: number;
  averageConfidence: number;
  maxConfidence: number;
};

const EXECUTION_DECISIONS = new Set<ContextDecisionValue>(["execute", "revise_and_execute"]);

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function capConfidence(value: number, cap: number | null): number {
  return cap === null ? clampConfidence(value) : Math.min(clampConfidence(value), cap);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function rule(params: {
  key: string;
  severity: "info" | "warning" | "blocking";
  message: string;
}): ContextDecisionReliabilityGate["appliedRules"][number] {
  return params;
}

function mergeRejectedActions(current: string[], originalDecision: ContextDecisionValue): string[] {
  if (originalDecision === "execute") return uniqueStrings([...current, "execute"]);
  return uniqueStrings([...current, originalDecision]);
}

export function applyContextDecisionReliabilityGate(params: {
  judgment: ContextDecisionJudgmentLike;
  knowledgeAssessment: ContextDecisionKnowledgeAssessment;
  evidence: DecisionEvidenceCandidate[];
  relatedBadSignalSummary: RelatedDecisionBadSignalSummary;
}): {
  judgment: ContextDecisionJudgmentLike;
  gate: ContextDecisionReliabilityGate;
} {
  const originalDecision = params.judgment.decision;
  const riskEvidence = params.evidence.filter((item) => item.role === "risk_warning");
  const supportEvidence = params.evidence.filter((item) => item.role === "selected_support");
  const appliedRules: ContextDecisionReliabilityGate["appliedRules"] = [];
  let decision = originalDecision;
  let confidenceCap: number | null = null;

  const constrain = (
    nextDecision: ContextDecisionValue,
    cap: number,
    nextRule: (typeof appliedRules)[number],
  ) => {
    appliedRules.push(nextRule);
    decision = nextDecision;
    confidenceCap = confidenceCap === null ? cap : Math.min(confidenceCap, cap);
  };

  if (params.knowledgeAssessment.status === "no_evidence") {
    constrain(
      "escalate",
      34,
      rule({
        key: "no_usable_evidence_escalate",
        severity: "blocking",
        message:
          "No selected support or preference evidence is available for autonomous execution.",
      }),
    );
  } else if (
    params.knowledgeAssessment.status === "weak_coverage" &&
    originalDecision === "execute"
  ) {
    constrain(
      "revise_and_execute",
      68,
      rule({
        key: "weak_coverage_requires_revision",
        severity: "warning",
        message:
          "Knowledge coverage is weak, so direct execute is constrained to revise_and_execute.",
      }),
    );
  }

  if (params.knowledgeAssessment.riskStrength >= 80 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "reject",
      72,
      rule({
        key: "strong_risk_evidence_blocks_execution",
        severity: "blocking",
        message:
          "Strong selected risk evidence blocks execution until the risk condition is resolved.",
      }),
    );
  } else if (riskEvidence.length > 0 && decision === "execute") {
    constrain(
      "revise_and_execute",
      72,
      rule({
        key: "risk_evidence_requires_revision",
        severity: "warning",
        message: "Selected risk evidence requires revision or verification before execution.",
      }),
    );
  }

  if (
    params.relatedBadSignalSummary.strongCount > 0 &&
    supportEvidence.length > 0 &&
    decision === "execute"
  ) {
    constrain(
      "revise_and_execute",
      64,
      rule({
        key: "bad_feedback_suppresses_execute",
        severity: "warning",
        message:
          "Selected support evidence has strong prior bad feedback, so direct execute is suppressed.",
      }),
    );
  }

  const finalConfidence = capConfidence(params.judgment.confidence, confidenceCap);
  const constrained =
    decision !== originalDecision || finalConfidence !== params.judgment.confidence;
  const riskEvidenceTitles = uniqueStrings(riskEvidence.map((item) => item.knowledge.title)).slice(
    0,
    8,
  );
  const judgment: ContextDecisionJudgmentLike = constrained
    ? {
        ...params.judgment,
        decision,
        confidence: finalConfidence,
        selectedAction: decision === "execute" ? params.judgment.selectedAction : null,
        rejectedActions: mergeRejectedActions(params.judgment.rejectedActions, originalDecision),
        mandate:
          decision === "escalate"
            ? "Escalate because the reliability gate did not find enough evidence for autonomous execution."
            : decision === "reject"
              ? "Do not execute until blocking risk evidence is resolved."
              : "Revise scope or verification before executing.",
        reasoningSummary: `${params.judgment.reasoningSummary} Reliability gate constrained the final decision because ${appliedRules
          .map((item) => item.key)
          .join(", ")}.`,
      }
    : {
        ...params.judgment,
        confidence: finalConfidence,
      };

  return {
    judgment,
    gate: {
      status: constrained ? "constrained" : "passed",
      originalDecision,
      finalDecision: judgment.decision,
      confidenceCap,
      appliedRules,
      riskEvidence: {
        count: riskEvidence.length,
        forcedDisplay: riskEvidence.length > 0,
        titles: riskEvidenceTitles,
      },
      badFeedback: params.relatedBadSignalSummary,
      evidenceCoverage: {
        assessmentStatus: params.knowledgeAssessment.status,
        supportEvidenceCount: supportEvidence.length,
        riskEvidenceCount: riskEvidence.length,
        knowledgeCoverage: params.knowledgeAssessment.knowledgeCoverage,
      },
    },
  };
}
