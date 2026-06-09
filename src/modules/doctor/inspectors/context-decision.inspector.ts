import { execFileSync } from "node:child_process";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { getContextDecisionMetrics } from "../../context-decision/context-decision.repository.js";

export type ContextDecisionInspection = {
  report: DoctorReport["contextDecision"];
  reasons: string[];
};

function isGhAvailable(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function inspectContextDecision(params: {
  tableAvailable: boolean;
}): Promise<ContextDecisionInspection> {
  const reasons: string[] = [];
  const ghAvailable = isGhAvailable();

  if (!params.tableAvailable) {
    reasons.push("CONTEXT_DECISION_TABLES_MISSING");
    if (!ghAvailable) reasons.push("CONTEXT_DECISION_GH_UNAVAILABLE");
    return {
      reasons,
      report: {
        available: false,
        totalDecisions: 0,
        decisionCounts: {},
        escalateRate: 0,
        escalateTargetRate: 0.1,
        goodFeedbackCount: 0,
        badFeedbackCount: 0,
        prDiscardFeedbackCount: 0,
        autoAppliedEffectsCount: 0,
        queuedEffectsCount: 0,
        degradedDecisionsCount: 0,
        requiredZeroEvidenceCount: 0,
        ghAvailable,
        nextActions: ["Run database migrations for context_decision tables."],
      },
    };
  }

  const metrics = await getContextDecisionMetrics();
  if (metrics.escalateRate >= 0.1 && metrics.totalDecisions > 0) {
    reasons.push("CONTEXT_DECISION_ESCALATE_RATE_HIGH");
  }
  if (metrics.queuedEffectsCount > 0) {
    reasons.push("CONTEXT_DECISION_FEEDBACK_EFFECTS_QUEUED");
  }
  if (metrics.requiredZeroEvidenceCount > 0) {
    reasons.push("CONTEXT_DECISION_REQUIRED_ZERO_EVIDENCE");
  }
  if (!ghAvailable) {
    reasons.push("CONTEXT_DECISION_GH_UNAVAILABLE");
  }

  return {
    reasons,
    report: {
      available: true,
      totalDecisions: metrics.totalDecisions,
      decisionCounts: metrics.decisionCounts,
      escalateRate: metrics.escalateRate,
      escalateTargetRate: 0.1,
      goodFeedbackCount: metrics.goodFeedbackCount,
      badFeedbackCount: metrics.badFeedbackCount,
      prDiscardFeedbackCount: metrics.prDiscardFeedbackCount,
      autoAppliedEffectsCount: metrics.autoAppliedEffectsCount,
      queuedEffectsCount: metrics.queuedEffectsCount,
      degradedDecisionsCount: metrics.degradedDecisionsCount,
      requiredZeroEvidenceCount: metrics.requiredZeroEvidenceCount,
      ghAvailable,
      nextActions: [
        ...(metrics.escalateRate >= 0.1 && metrics.totalDecisions > 0
          ? [
              `Review high context_decision escalate rate (${Math.round(
                metrics.escalateRate * 100,
              )}%).`,
            ]
          : []),
        ...(metrics.queuedEffectsCount > 0
          ? [`Review queued context_decision feedback effects (${metrics.queuedEffectsCount}).`]
          : []),
        ...(metrics.requiredZeroEvidenceCount > 0
          ? [
              `Inspect required Knowledge decisions with zero support evidence (${metrics.requiredZeroEvidenceCount}).`,
            ]
          : []),
        ...(!ghAvailable ? ["Install/authenticate GitHub CLI for PR discard feedback scans."] : []),
      ],
    },
  };
}
