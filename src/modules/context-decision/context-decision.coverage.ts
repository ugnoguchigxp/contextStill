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

function hintLine(label: string, values: string[] | undefined): string | undefined {
  const compacted = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (compacted.length === 0) return undefined;
  return `${label}: ${compacted.join(" ")}`;
}

function retrievalHintText(input: ContextDecisionInput): string {
  return compactText([
    hintLine("technologies", input.retrievalHints.technologies),
    hintLine("changeTypes", input.retrievalHints.changeTypes),
    hintLine("domains", input.retrievalHints.domains),
  ]);
}

export function buildDecisionCoverageQueries(input: ContextDecisionInput): DecisionCoverageQuery[] {
  const hints = retrievalHintText(input);
  const support = compactText([input.decisionPoint, hints]);
  const counter = compactText([
    "avoid rollback discard risk counter evidence",
    input.decisionPoint,
    hints,
  ]);
  const preference = compactText(["user preference prior decision", input.decisionPoint, hints]);
  const risk = compactText(["risk warning guardrail verification", input.decisionPoint, hints]);

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
