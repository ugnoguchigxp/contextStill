import type { ContextDecisionInput } from "../../shared/schemas/context-decision.schema.js";

export type DecisionCoverageQuery = {
  query: string;
  queryRole:
    | "support"
    | "counter_evidence"
    | "user_preference"
    | "risk"
    | "verification"
    | "alternative";
  reason: string;
  normalizedKeywords: string[];
  retrievalInput: string;
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

function normalizedDecisionKeywords(input: ContextDecisionInput): string[] {
  const text = compactText([
    input.decisionPoint,
    ...(input.retrievalHints.technologies ?? []),
    ...(input.retrievalHints.changeTypes ?? []),
    ...(input.retrievalHints.domains ?? []),
  ]);
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "whether",
    "should",
    "continue",
    "ask",
    "user",
    "now",
  ]);
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_-]+/u)
        .map((word) => word.trim())
        .filter((word) => word.length >= 3 && !stopWords.has(word)),
    ),
  ).slice(0, 16);
}

function coverageQuery(params: {
  query: string;
  queryRole: DecisionCoverageQuery["queryRole"];
  reason: string;
  keywords: string[];
}): DecisionCoverageQuery {
  return {
    ...params,
    normalizedKeywords: params.keywords,
    retrievalInput: compactText([params.query, `keywords: ${params.keywords.join(" ")}`]),
  };
}

export function buildDecisionCoverageQueries(input: ContextDecisionInput): DecisionCoverageQuery[] {
  const hints = retrievalHintText(input);
  const keywords = normalizedDecisionKeywords(input);
  const support = compactText([
    "safe to execute minimal change existing pattern implementation procedure proceed",
    input.decisionPoint,
    hints,
  ]);
  const counter = compactText([
    "do not proceed reject rollback discard counterexample blocked failure condition incompatible evidence",
    input.decisionPoint,
    hints,
  ]);
  const preference = compactText([
    "user preference prior decision requested style preferred workflow",
    input.decisionPoint,
    hints,
  ]);
  const risk = compactText(["risk warning guardrail verification", input.decisionPoint, hints]);
  const verification = compactText([
    "verification required tests acceptance criteria completion checks",
    input.decisionPoint,
    hints,
  ]);
  const alternative = compactText([
    "alternative approach revise instead escalation ask user defer split scope conditions",
    input.decisionPoint,
    hints,
  ]);

  return [
    coverageQuery({
      query: support,
      queryRole: "support",
      reason: "supporting knowledge for the requested decision",
      keywords,
    }),
    coverageQuery({
      query: counter,
      queryRole: "counter_evidence",
      reason: "counter evidence and alternatives search",
      keywords,
    }),
    coverageQuery({
      query: risk,
      queryRole: "risk",
      reason: "risk and guardrail search",
      keywords,
    }),
    coverageQuery({
      query: preference,
      queryRole: "user_preference",
      reason: "prior user preference search",
      keywords,
    }),
    coverageQuery({
      query: verification,
      queryRole: "verification",
      reason: "verification criteria search",
      keywords,
    }),
    coverageQuery({
      query: alternative,
      queryRole: "alternative",
      reason: "alternative action and escalation condition search",
      keywords,
    }),
  ];
}
