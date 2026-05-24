import {
  RULE_BODY_NOT_ACTIONABLE_REASON,
  RULE_UNSUPPORTED_BY_SOURCE_REASON,
  assessRuleQuality,
} from "./rule-quality.js";

export const PROCEDURE_BODY_NOT_ACTIONABLE_REASON = "procedure_body_not_actionable";
export const PROCEDURE_REPAIR_FAILED_REASON = "procedure_repair_failed";

export type CandidateQualityType = "rule" | "procedure";

export type ProcedureQualityDecision =
  | {
      action: "accept_procedure";
      type: "procedure";
      reason: "skill_like_procedure";
    }
  | {
      action: "repair_procedure";
      type: "procedure";
      reason: "procedure_has_workflow_signal";
    }
  | {
      action: "demote_to_rule";
      type: "rule";
      reason: "explicit_rule_type" | "rule_like_non_procedure";
    }
  | {
      action: "reject_insufficient";
      type: CandidateQualityType;
      reason:
        | typeof PROCEDURE_BODY_NOT_ACTIONABLE_REASON
        | typeof RULE_BODY_NOT_ACTIONABLE_REASON
        | typeof RULE_UNSUPPORTED_BY_SOURCE_REASON;
    };

export type CandidateQualityDecision<T extends { type: CandidateQualityType }> =
  | {
      action: "accept";
      candidate: T | (Omit<T, "type"> & { type: "rule" });
      reason:
        | "skill_like_procedure"
        | "rule_like_body"
        | "explicit_rule_type"
        | "rule_like_non_procedure";
    }
  | {
      action: "reject";
      type: CandidateQualityType;
      reason:
        | typeof PROCEDURE_BODY_NOT_ACTIONABLE_REASON
        | typeof RULE_BODY_NOT_ACTIONABLE_REASON
        | typeof RULE_UNSUPPORTED_BY_SOURCE_REASON;
    };

function sectionIndex(body: string, heading: string): number {
  return body.search(new RegExp(`^${heading}:`, "im"));
}

function workflowSection(body: string): string {
  const workflowStart = sectionIndex(body, "Workflow");
  const verificationStart = sectionIndex(body, "Verification");
  if (workflowStart < 0 || verificationStart <= workflowStart) return "";
  return body.slice(workflowStart, verificationStart);
}

function countWorkflowSteps(body: string): number {
  return workflowSection(body)
    .split("\n")
    .filter((line) => /^\s*(?:\d+[.)]|-)\s+\S/.test(line)).length;
}

export function hasSkillLikeProcedureBody(body: string): boolean {
  const useWhen = sectionIndex(body, "Use when");
  const workflow = sectionIndex(body, "Workflow");
  const verification = sectionIndex(body, "Verification");
  const avoid = sectionIndex(body, "Avoid");
  return (
    useWhen >= 0 &&
    workflow > useWhen &&
    verification > workflow &&
    avoid > verification &&
    countWorkflowSteps(body) >= 2
  );
}

export function hasProcedureWorkflowSignal(title: string, body: string): boolean {
  const text = `${title}\n${body}`.toLowerCase();
  const hasSequenceMarker =
    /(\bstep\b|\bsteps\b|\bthen\b|\bafter\b|\bfirst\b|\bfinally\b|まず|次に|その後|最後に|してから|順に|順序|1[.)]|2[.)])/i.test(
      text,
    );
  const hasWorkflowMarker =
    /(\bworkflow\b|\brunbook\b|\bplaybook\b|\bprocedure\b|手順|運用|復旧|再実行|レビュー手順|検証手順|確認手順|ワークフロー)/i.test(
      text,
    );
  const hasCommandMarker =
    /(`[^`]+`|\b(?:bun|bunx|pnpm|npm|yarn|git|docker|terraform|kubectl|psql|curl|aws)\b|\bcli\b|コマンド)/i.test(
      text,
    );
  const hasVerificationMarker =
    /(\bverify\b|\bsmoke\b|\bdoctor\b|\btests?\b|\binspect\b|\bconfirm\b|\blint\b|\btypecheck\b|\bformat\b|\bbuild\b|\bmigrate\b|\bdeploy\b|検証|確認|起動|実行)/i.test(
      text,
    );

  return (
    hasSkillLikeProcedureBody(body) ||
    (hasWorkflowMarker && (hasSequenceMarker || hasCommandMarker || hasVerificationMarker)) ||
    (hasSequenceMarker && hasCommandMarker) ||
    (hasSequenceMarker && hasVerificationMarker)
  );
}

export function shouldDemoteProcedureToRule(params: { title: string; body: string }): boolean {
  return assessProcedureQuality(params).action === "demote_to_rule";
}

export function assessProcedureQuality(params: {
  title: string;
  body: string;
  typeHint?: CandidateQualityType;
  sourceSupported?: boolean;
}): ProcedureQualityDecision {
  if (hasSkillLikeProcedureBody(params.body)) {
    return {
      action: "accept_procedure",
      type: "procedure",
      reason: "skill_like_procedure",
    };
  }

  if (params.typeHint === "rule") {
    const ruleDecision = assessRuleQuality({
      title: params.title,
      body: params.body,
      explicitRule: true,
      sourceSupported: params.sourceSupported,
    });
    if (ruleDecision.action === "accept_rule") {
      return {
        action: "demote_to_rule",
        type: "rule",
        reason: "explicit_rule_type",
      };
    }
    return {
      action: "reject_insufficient",
      type: "rule",
      reason: ruleDecision.reason,
    };
  }

  if (hasProcedureWorkflowSignal(params.title, params.body)) {
    return {
      action: "repair_procedure",
      type: "procedure",
      reason: "procedure_has_workflow_signal",
    };
  }

  const ruleDecision = assessRuleQuality({
    title: params.title,
    body: params.body,
    sourceSupported: params.sourceSupported,
  });
  if (ruleDecision.action === "accept_rule") {
    return {
      action: "demote_to_rule",
      type: "rule",
      reason: "rule_like_non_procedure",
    };
  }

  return {
    action: "reject_insufficient",
    type: ruleDecision.reason === RULE_UNSUPPORTED_BY_SOURCE_REASON ? "rule" : "procedure",
    reason:
      ruleDecision.reason === RULE_UNSUPPORTED_BY_SOURCE_REASON
        ? ruleDecision.reason
        : PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  };
}

export function validateCandidateQualityForStorage<
  T extends { type: CandidateQualityType; title: string; body: string },
>(
  candidate: T,
  options: { typeHint?: CandidateQualityType; sourceSupported?: boolean } = {},
): CandidateQualityDecision<T> {
  if (candidate.type === "rule") {
    const ruleDecision = assessRuleQuality({
      title: candidate.title,
      body: candidate.body,
      explicitRule: options.typeHint === "rule",
      sourceSupported: options.sourceSupported,
    });
    if (ruleDecision.action === "accept_rule") {
      return {
        action: "accept",
        candidate,
        reason: ruleDecision.reason,
      };
    }
    return {
      action: "reject",
      type: "rule",
      reason: ruleDecision.reason,
    };
  }

  const procedureDecision = assessProcedureQuality({
    title: candidate.title,
    body: candidate.body,
    typeHint: options.typeHint,
    sourceSupported: options.sourceSupported,
  });
  if (procedureDecision.action === "accept_procedure") {
    return {
      action: "accept",
      candidate,
      reason: procedureDecision.reason,
    };
  }
  if (procedureDecision.action === "demote_to_rule") {
    return {
      action: "accept",
      candidate: {
        ...candidate,
        type: "rule",
      },
      reason: procedureDecision.reason,
    };
  }
  return {
    action: "reject",
    type: procedureDecision.type,
    reason:
      procedureDecision.action === "repair_procedure"
        ? PROCEDURE_BODY_NOT_ACTIONABLE_REASON
        : procedureDecision.reason,
  };
}

export { RULE_BODY_NOT_ACTIONABLE_REASON, RULE_UNSUPPORTED_BY_SOURCE_REASON };
