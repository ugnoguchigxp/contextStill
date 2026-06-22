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
const OBVIOUS_RISK_REJECT_THRESHOLD = 90;
const HIGH_IMPACT_ACTIVE_LEASE_THRESHOLD = 3;
const HIGH_IMPACT_USER_THRESHOLD = 10;

type OperationalImpactSummary = NonNullable<ContextDecisionReliabilityGate["operationalImpact"]>;

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

function mergeRejectedActions(
  current: string[],
  originalDecision: ContextDecisionValue,
  finalDecision: ContextDecisionValue,
): string[] {
  const additions: string[] = [];
  if (finalDecision === "revise_and_execute" && originalDecision === "execute") {
    additions.push("execute");
  } else if (!EXECUTION_DECISIONS.has(finalDecision) && originalDecision !== finalDecision) {
    additions.push(originalDecision);
  }
  return uniqueStrings([...current, ...additions]);
}

function supportEvidenceWithSignals(
  evidence: DecisionEvidenceCandidate[],
): DecisionEvidenceCandidate[] {
  return evidence.filter(
    (item) => item.role === "selected_support" || item.role === "user_preference",
  );
}

function recordValue(input: Record<string, unknown>, key: string): unknown {
  const direct = input[key];
  if (direct !== undefined) return direct;
  const runtimeEvidence = input.runtimeEvidence;
  if (runtimeEvidence && typeof runtimeEvidence === "object" && !Array.isArray(runtimeEvidence)) {
    return (runtimeEvidence as Record<string, unknown>)[key];
  }
  return undefined;
}

function numberValue(input: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = recordValue(input, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function stringValue(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = recordValue(input, key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function assessOperationalImpact(params: {
  decisionPoint: string;
  metadata?: Record<string, unknown>;
}): OperationalImpactSummary {
  const metadata = params.metadata ?? {};
  const text = `${params.decisionPoint} ${JSON.stringify(metadata)}`.toLowerCase();
  const processRestart =
    /\b(launchagent|restart|reload|unload|load|supervisor|worker|daemon|service|process)\b/.test(
      text,
    ) || /再起動|停止|起動|リロード/.test(params.decisionPoint);
  const destructive =
    /\b(rm\s+-rf|git clean|reset --hard|drop table|delete database|wipe|irreversible|destructive)\b/.test(
      text,
    ) || /破壊|削除|不可逆/.test(params.decisionPoint);
  const activeLeaseCount = numberValue(metadata, [
    "activeLeaseCount",
    "activeJobCount",
    "runningJobCount",
    "inFlightJobCount",
  ]);
  const impactedUserEstimate = numberValue(metadata, [
    "impactedUserEstimate",
    "activeUserCount",
    "connectedClientCount",
    "activeSessionCount",
    "requestRate",
  ]);
  const runningQueue = stringValue(metadata, ["runningQueue", "queueName"]);
  const pendingQueueKey = runningQueue
    ? `pending${runningQueue.charAt(0).toUpperCase()}${runningQueue.slice(1)}`
    : "";
  const pendingCount = numberValue(metadata, ["pendingCount", pendingQueueKey]);

  if (destructive) {
    return {
      operationType: "destructive_change",
      level: "high",
      activeLeaseCount,
      impactedUserEstimate,
      reason: "The decision point or metadata describes a destructive or irreversible action.",
      autonomousGoRecommended: false,
    };
  }

  if (!processRestart) {
    return {
      operationType: "unknown",
      level: "unknown",
      activeLeaseCount,
      impactedUserEstimate,
      reason: "No process restart/reload operation was detected.",
      autonomousGoRecommended: false,
    };
  }

  if (activeLeaseCount === null && impactedUserEstimate === null) {
    return {
      operationType: "process_restart",
      level: "unknown",
      activeLeaseCount,
      impactedUserEstimate,
      reason:
        "Process restart/reload was detected, but no active work or user impact metadata was available.",
      autonomousGoRecommended: false,
    };
  }

  const userImpact = impactedUserEstimate ?? 0;
  const leaseImpact = activeLeaseCount ?? 0;
  const level: OperationalImpactSummary["level"] =
    userImpact >= HIGH_IMPACT_USER_THRESHOLD || leaseImpact >= HIGH_IMPACT_ACTIVE_LEASE_THRESHOLD
      ? "high"
      : userImpact > 0 || leaseImpact > 0
        ? "medium"
        : "low";
  const impactBits = [
    `activeLeaseCount=${activeLeaseCount ?? "unknown"}`,
    `impactedUserEstimate=${impactedUserEstimate ?? "unknown"}`,
    runningQueue ? `runningQueue=${runningQueue}` : null,
    pendingCount !== null ? `pendingCount=${pendingCount}` : null,
  ].filter((item): item is string => Boolean(item));

  return {
    operationType: "process_restart",
    level,
    activeLeaseCount,
    impactedUserEstimate,
    reason: `Process restart/reload impact estimate: ${impactBits.join(", ") || "no live impact metadata"}.`,
    autonomousGoRecommended: level === "low" || level === "medium",
  };
}

export function applyContextDecisionReliabilityGate(params: {
  judgment: ContextDecisionJudgmentLike;
  knowledgeAssessment: ContextDecisionKnowledgeAssessment;
  evidence: DecisionEvidenceCandidate[];
  relatedBadSignalSummary: RelatedDecisionBadSignalSummary;
  decisionPoint?: string;
  metadata?: Record<string, unknown>;
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
  const operationalImpact = assessOperationalImpact({
    decisionPoint: params.decisionPoint ?? "",
    metadata: params.metadata,
  });
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

  if (
    params.knowledgeAssessment.riskStrength >= OBVIOUS_RISK_REJECT_THRESHOLD &&
    EXECUTION_DECISIONS.has(decision)
  ) {
    constrain(
      "reject",
      72,
      rule({
        key: "strong_risk_evidence_blocks_execution",
        severity: "blocking",
        message:
          "Very strong selected risk evidence blocks execution until the risk condition is resolved.",
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
      "revise_and_execute",
      58,
      rule({
        key: "compile_wrong_requires_revision",
        severity: "warning",
        message:
          "Prior compile feedback marked selected support as wrong, so continue only with revised scope or verification.",
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
      "revise_and_execute",
      62,
      rule({
        key: "negative_attractor_requires_revision",
        severity: "warning",
        message:
          "Selected support belongs to a negative attractor community, so continue only with revised scope or verification.",
      }),
    );
  }

  if (wrongReviewRequiredSupport.length > 0 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "revise_and_execute",
      60,
      rule({
        key: "wrong_review_required_requires_revision",
        severity: "warning",
        message:
          "Selected support belongs to a community flagged for wrong-review, so continue only with revised scope or verification.",
      }),
    );
  }

  if (deadCommunitySupport.length > 0 && EXECUTION_DECISIONS.has(decision)) {
    constrain(
      "revise_and_execute",
      55,
      rule({
        key: "dead_community_requires_revision",
        severity: "warning",
        message:
          "Selected support belongs to a dead community signal, so continue only with revised scope or verification.",
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

  if (
    originalDecision === "reject" &&
    decision === "reject" &&
    params.knowledgeAssessment.riskStrength < OBVIOUS_RISK_REJECT_THRESHOLD
  ) {
    constrain(
      "revise_and_execute",
      60,
      rule({
        key: "non_obvious_risk_reject_softened_to_revision",
        severity: "warning",
        message:
          "Reject is reserved for obvious blocking danger; non-blocking uncertainty should continue with revised scope or verification.",
      }),
    );
  }

  if (
    operationalImpact.autonomousGoRecommended &&
    (decision === "reject" || decision === "escalate") &&
    !appliedRules.some(
      (item) =>
        item.key === "no_usable_evidence_escalate" ||
        item.key === "decision_signal_load_failure_blocks_execution",
    )
  ) {
    constrain(
      operationalImpact.level === "low" ? "execute" : "revise_and_execute",
      operationalImpact.level === "low" ? 70 : 64,
      rule({
        key: "bounded_operational_impact_supports_autonomous_go",
        severity: "warning",
        message:
          "Operational metadata indicates bounded restart/reload impact, so Decision should choose GO with safeguards instead of asking the user.",
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
        rejectedActions: mergeRejectedActions(
          params.judgment.rejectedActions,
          originalDecision,
          decision,
        ),
        mandate:
          decision === "escalate"
            ? "Escalate because the reliability gate did not find enough evidence for autonomous execution."
            : decision === "reject"
              ? "Do not execute until obvious blocking risk evidence is resolved."
              : "Revise scope or verification, then continue executing.",
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
      operationalImpact,
    },
  };
}
