import { decideContext } from "../../modules/context-decision/context-decision.service.js";
import { recordContextDecisionFeedback } from "../../modules/context-decision/context-decision.feedback.service.js";
import type { ToolEntry } from "../registry.js";

export const contextDecisionTool: ToolEntry = {
  name: "context_decision",
  description:
    "Use before asking the user when blocked, before PR creation, after failed tests/review, or when unfinished Todo/status remains. Returns a decision, not options. Escalate only when autonomous progress is not possible.",
  inputSchema: {
    type: "object",
    properties: {
      taskGoal: { type: "string" },
      decisionPoint: { type: "string" },
      proposedAction: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      autonomyLevel: { type: "string", enum: ["low", "medium", "high"] },
      riskBudget: { type: "string", enum: ["low", "medium", "high"] },
      availableRollback: { type: "string" },
      verificationPlan: { type: "string" },
      knowledgePolicy: { type: "string", enum: ["optional", "required"] },
      sessionId: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["taskGoal", "decisionPoint"],
  },
  handler: async (args) => {
    const result = await decideContext(args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};

export const contextDecisionFeedbackTool: ToolEntry = {
  name: "context_decision_feedback",
  description:
    "Record Good/Bad human feedback or AI/system outcome feedback for a context_decision decisionId.",
  inputSchema: {
    type: "object",
    properties: {
      decisionId: { type: "string" },
      source: { type: "string", enum: ["human", "ai", "system"] },
      value: { type: "string", enum: ["good", "bad"] },
      outcome: {
        type: "string",
        enum: [
          "success",
          "failed",
          "discarded_pr",
          "user_overrode",
          "regression_found",
          "still_unknown",
        ],
      },
      reason: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["decisionId", "source"],
  },
  handler: async (args) => {
    const result = await recordContextDecisionFeedback(args as never);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};
