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

function supportEvidenceWithSignals(
  evidence: DecisionEvidenceCandidate[],
): DecisionEvidenceCandidate[] {
  return evidence.filter(
    (item) => item.role === "selected_support" || item.role === "user_preference",
  );
}

export function applyContextDecisionReliabilityGate(params: {
  judgment: ContextDecisionJudgmentLike;
  knowledgeAssessment: ContextDecisionKnowledgeAssessment;
  evidence: DecisionEvidenceCandidate[];
  relatedBadSignalSummary: RelatedDecisionBadSignalSummary;
  signalLoadStatus?: "complete" | "partial" | "failed";
  signalLoadReason?: string;
}): {
  judgment: ContextDecisionJudgmentLike;
  gate: ContextDecisionReliabilityGate;
} {
  const originalDecision = params.judgment.decision;
  const riskEvidence = params.evidence.filter((item) => item.role === "risk_warning");
  const supportEvidence = params.evidence.filter((item) => item.role === "selected_support");
  const signalSupportEvidence = supportEvidenceWithSignals(params.evidence);
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

  if (params.signalLoadStatus === "failed" && EXECUTION_DECISIONS.has(decision)) {
    const reason = params.signalLoadReason ? ` Reason: ${params.signalLoadReason}` : "";
    constrain(
      "escalate",
      45,
      rule({
        key: "decision_signal_load_failure_blocks_execution",
        severity: "blocking",
        message: `Decision signal loading failed, so autonomous execution is blocked.${reason}`,
      }),
    );
  }

  const compileWrongSupport = signalSupportEvidence.filter(
    (item) => (item.signals?.compile?.wrongCount ?? 0) > 0,
  );
  const compileOffTopicSupport = signalSupportEvidence.filter(
    (item) => (item.signals?.compile?.offTopicCount ?? 0) > 0,
  );
  const negativeAttractorSupport = signalSupportEvidence.filter(
    (item) => item.signals?.landscape?.classification === "negative_attractor_candidate",
  );
  const wrongReviewRequiredSupport = signalSupportEvidence.filter((item) =>
    item.signals?.landscape?.flags.includes("wrong_review_required"),
  );
  const overSelectedNotUsedSupport = signalSupportEvidence.filter(
    (item) => item.signals?.landscape?.classification === "over_selected_not_used",
  );
  const deadCommunitySupport = signalSupportEvidence.filter(
    (item) => item.signals?.community?.health.dead,
  );
  const thinCommunitySupport = signalSupportEvidence.filter(
    (item) => item.signals?.community?.health.thinEvidence,
  );
  const staleCommunitySupport = signalSupportEvidence.filter(
    (item) => item.signals?.community?.health.stale,
  );
  const strongAttractorSupport = signalSupportEvidence.filter(
    (item) =>
      item.signals?.landscape?.classification === "strong_attractor" ||
      item.signals?.landscape?.classification === "useful_attractor",
  );

  if (compileWrongSupport.length > 0 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "reject",
      58,
      rule({
        key: "compile_wrong_blocks_execute",
        severity: "blocking",
        message: "Prior compile feedback marked selected support as wrong.",
      }),
    );
  } else if (compileOffTopicSupport.length > 0 && decision === "execute") {
    constrain(
      "revise_and_execute",
      64,
      rule({
        key: "compile_off_topic_requires_revision",
        severity: "warning",
        message: "Prior compile feedback marked selected support as off topic.",
      }),
    );
  }

  if (negativeAttractorSupport.length > 0 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "reject",
      62,
      rule({
        key: "negative_attractor_blocks_execute",
        severity: "blocking",
        message: "Selected support belongs to a negative attractor community.",
      }),
    );
  }

  if (wrongReviewRequiredSupport.length > 0 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "reject",
      60,
      rule({
        key: "wrong_review_required_blocks_execute",
        severity: "blocking",
        message: "Selected support belongs to a community flagged for wrong-review.",
      }),
    );
  }

  if (deadCommunitySupport.length > 0 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "reject",
      55,
      rule({
        key: "dead_community_blocks_execute",
        severity: "blocking",
        message: "Selected support belongs to a dead community signal.",
      }),
    );
  }

  if (overSelectedNotUsedSupport.length > 0 && decision === "execute") {
    constrain(
      "revise_and_execute",
      66,
      rule({
        key: "over_selected_not_used_requires_revision",
        severity: "warning",
        message: "Selected support comes from an over-selected/not-used community.",
      }),
    );
  }

  if (thinCommunitySupport.length > 0 && EXECUTION_DECISIONS.has(originalDecision)) {
    appliedRules.push(
      rule({
        key: "thin_community_caps_confidence",
        severity: "warning",
        message: "Selected support comes from a thin-evidence community.",
      }),
    );
    confidenceCap = confidenceCap === null ? 70 : Math.min(confidenceCap, 70);
  }

  if (staleCommunitySupport.length > 0 && EXECUTION_DECISIONS.has(originalDecision)) {
    appliedRules.push(
      rule({
        key: "stale_community_caps_confidence",
        severity: "warning",
        message: "Selected support comes from a stale community.",
      }),
    );
    confidenceCap = confidenceCap === null ? 68 : Math.min(confidenceCap, 68);
  }

  if (
    strongAttractorSupport.length > 0 &&
    decision === "execute" &&
    compileWrongSupport.length === 0 &&
    negativeAttractorSupport.length === 0
  ) {
    appliedRules.push(
      rule({
        key: "strong_attractor_supports_execute",
        severity: "info",
        message: "Selected support comes from a strong or useful attractor community.",
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
