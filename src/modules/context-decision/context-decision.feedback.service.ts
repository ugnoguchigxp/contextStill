import {
  type ContextDecisionEvidenceRole,
  type ContextDecisionFeedbackInput,
  type ContextDecisionHumanFeedbackValue,
  contextDecisionFeedbackInputSchema,
} from "../../shared/schemas/context-decision.schema.js";
import {
  getContextDecisionDetail,
  insertDecisionFeedbackEffects,
  insertDecisionSystemFeedback,
  listContextDecisionKnowledgeIdsByRoles,
  listSelectedSupportKnowledgeIds,
  saveHumanDecisionFeedback,
} from "./context-decision.repository.js";

export class ContextDecisionFeedbackError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ContextDecisionFeedbackError";
    this.statusCode = statusCode;
  }
}

function buildSystemFeedbackEffects(params: {
  affectedKnowledgeIds: string[];
  isClearNegative: boolean;
  outcome: string;
  source: string;
}) {
  if (params.affectedKnowledgeIds.length === 0) {
    return [
      {
        knowledgeId: null,
        effect: "neutral" as const,
        amount: 0,
        reason: `System feedback outcome: ${params.outcome}; no decision-driving knowledge was attached.`,
        confidence: 55,
        status: "skipped" as const,
        metadata: { source: params.source, reason: "no_decision_driving_knowledge" },
      },
    ];
  }
  return params.affectedKnowledgeIds.map((knowledgeId) => ({
    knowledgeId,
    effect: params.isClearNegative ? ("penalize" as const) : ("neutral" as const),
    amount: params.isClearNegative ? -4 : 0,
    reason: `System feedback outcome: ${params.outcome}.`,
    confidence: params.isClearNegative ? 72 : 55,
    status: "applied" as const,
    metadata: { source: params.source },
  }));
}

function supportRoles(): ContextDecisionEvidenceRole[] {
  return ["selected_support", "user_preference"];
}

function cautionRoles(): ContextDecisionEvidenceRole[] {
  return ["risk_warning", "counter_evidence"];
}

function feedbackTargetRoles(params: {
  decision: string;
  value?: ContextDecisionHumanFeedbackValue;
  outcome?: string;
}): ContextDecisionEvidenceRole[] {
  const negativeOutcome =
    params.outcome === "discarded_pr" ||
    params.outcome === "failed" ||
    params.outcome === "regression_found" ||
    params.outcome === "user_overrode";
  if (params.decision === "execute") return supportRoles();
  if (params.decision === "revise_and_execute") {
    return params.value === "bad" || negativeOutcome ? supportRoles() : cautionRoles();
  }
  if (
    params.decision === "reject" ||
    params.decision === "rollback" ||
    params.decision === "discard"
  ) {
    return cautionRoles();
  }
  if (params.decision === "escalate") {
    return params.value === "bad" || negativeOutcome ? supportRoles() : cautionRoles();
  }
  return supportRoles();
}

async function listFeedbackTargetKnowledgeIds(params: {
  decisionId: string;
  roles: ContextDecisionEvidenceRole[];
}): Promise<string[]> {
  if (params.roles.length === 1 && params.roles[0] === "selected_support") {
    return listSelectedSupportKnowledgeIds(params.decisionId);
  }
  return listContextDecisionKnowledgeIdsByRoles(params.decisionId, params.roles);
}

export async function recordContextDecisionFeedback(input: ContextDecisionFeedbackInput) {
  const parsed = contextDecisionFeedbackInputSchema.parse(input);
  const detail = await getContextDecisionDetail(parsed.decisionId);
  if (!detail) {
    throw new ContextDecisionFeedbackError(404, "Context decision not found.");
  }

  if (parsed.source === "human") {
    const value = parsed.value as ContextDecisionHumanFeedbackValue;
    const targetRoles = feedbackTargetRoles({ decision: detail.run.decision, value });
    const affectedKnowledgeIds = await listFeedbackTargetKnowledgeIds({
      decisionId: parsed.decisionId,
      roles: targetRoles,
    });
    return {
      humanFeedback: await saveHumanDecisionFeedback({
        decisionId: parsed.decisionId,
        value,
        affectedKnowledgeIds,
      }),
    };
  }

  const targetRoles = feedbackTargetRoles({
    decision: detail.run.decision,
    outcome: parsed.outcome ?? "still_unknown",
  });
  const affectedKnowledgeIds = await listFeedbackTargetKnowledgeIds({
    decisionId: parsed.decisionId,
    roles: targetRoles,
  });
  const feedback = await insertDecisionSystemFeedback({
    decisionId: parsed.decisionId,
    source: parsed.source,
    outcome: parsed.outcome ?? "still_unknown",
    inferredReason: parsed.reason?.trim() || "No reason supplied.",
    affectedKnowledgeIds,
    suggestedAdjustment: {},
    metadata: parsed.metadata,
  });
  const isClearNegative =
    feedback.outcome === "discarded_pr" ||
    feedback.outcome === "failed" ||
    feedback.outcome === "regression_found" ||
    feedback.outcome === "user_overrode";
  const effects = await insertDecisionFeedbackEffects({
    feedbackId: feedback.id,
    decisionId: parsed.decisionId,
    effects: buildSystemFeedbackEffects({
      affectedKnowledgeIds,
      isClearNegative,
      outcome: feedback.outcome,
      source: parsed.source,
    }),
  });
  return {
    feedback,
    effects,
  };
}
