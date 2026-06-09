import type { ContextDecisionInput } from "../../shared/schemas/context-decision.schema.js";

export type DecisionCoverageQuery = {
  query: string;
  queryRole: "support" | "counter_evidence" | "user_preference" | "risk";
  reason: string;
};

function compactText(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

export function buildDecisionCoverageQueries(input: ContextDecisionInput): DecisionCoverageQuery[] {
  const support = compactText([input.taskGoal, input.decisionPoint, input.proposedAction]);
  const counter = compactText([
    "avoid rollback discard risk counter evidence",
    input.decisionPoint,
    input.proposedAction,
  ]);
  const preference = compactText(["user preference prior decision", input.taskGoal]);
  const risk = compactText(["risk warning guardrail verification", input.decisionPoint]);

  return [
    {
      query: support,
      queryRole: "support",
      reason: "supporting knowledge for the requested decision",
    },
    {
      query: counter,
      queryRole: "counter_evidence",
      reason: "counter evidence and alternatives search",
    },
    { query: preference, queryRole: "user_preference", reason: "prior user preference search" },
    { query: risk, queryRole: "risk", reason: "risk and guardrail search" },
  ];
}
