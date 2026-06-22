import { recordContextDecisionFeedback } from "../../modules/context-decision/context-decision.feedback.service.js";
import { decideContext } from "../../modules/context-decision/context-decision.service.js";
import type { ToolEntry } from "../registry.js";

export const contextDecisionTool: ToolEntry = {
  name: "context_decision",
  description:
    "Use as an autonomous GO/NO-GO pre-question gate before you would otherwise ask the user when blocked, before PR creation, after failed tests/review, or when unfinished Todo/status remains. Returns a decision, not options. Estimate operational impact from metadata and Knowledge evidence; do not ask the user by default. Treat reject as a stop condition, but reserve it for obvious blocking danger or directly forbidden actions; prefer execute or revise_and_execute when safe autonomous progress remains possible. Escalate only when autonomous progress is not possible.",
  inputSchema: {
    type: "object",
    properties: {
      decisionPoint: { type: "string" },
      retrievalHints: {
        type: "object",
        properties: {
          technologies: { type: "array", items: { type: "string" } },
          changeTypes: { type: "array", items: { type: "string" } },
          domains: { type: "array", items: { type: "string" } },
        },
      },
      sessionId: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["decisionPoint"],
  },
  handler: async (args) => {
    const result = await decideContext(args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
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
