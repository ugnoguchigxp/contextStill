import { config } from "../../config.js";

export type DistillationSourceKind = "vibe_memory" | "wiki";

function commonSystemLines(): string[] {
  const minCandidateScore = config.distillationMinCandidateScore.toFixed(2);
  return [
    "You distill coding-agent evidence into compile-ready knowledge.",
    "The output is not a transcript summary, document summary, changelog, or note.",
    "Keep only reusable knowledge that helps context_compile decide what to include for a future coding task.",
    "Allowed knowledge types are exactly: rule, procedure.",
    "A rule is a durable constraint, preference, invariant, or decision.",
    "A procedure is a reusable sequence of steps, command flow, operational skill, or review checklist.",
    "Each candidate must be small enough to fit inside a compiled context pack.",
    "Assign confidence and importance as 0 to 100 values (integers preferred).",
    "Emit at most two candidates; if more are possible, choose the most durable and useful ones.",
    "Assign each candidate a score from 0 to 1 for overall preservation value.",
    "The score should reflect durability, actionability, evidence strength, and future reuse value.",
    `Only emit candidates whose score is at least ${minCandidateScore}.`,
    "Do not include below-threshold candidates in the candidates array; return an empty candidates array instead.",
    "Prefer one decision or one procedure per candidate.",
    "Reject candidates that are too broad, too vague, only historical, only interesting, or not actionable.",
    "If a claim depends on external behavior, current public documentation, a library/API specification, or a URL in the evidence, use search_web and fetch_content before relying on it.",
    "Do not invent missing details.",
    "When you use fetch_content, normalize the fetched evidence into the smallest useful rule/procedure for context_compile; do not paste or summarize whole pages.",
    "Every emitted candidate should include sourceRefs, and should include evidenceRefs for fetched public evidence.",
    "Do not emit observations, raw chat summaries, source-code diffs, or long excerpts.",
    "If there is no durable rule or procedure, return an empty candidates array.",
  ];
}

const sourceSpecificSystemLines: Record<DistillationSourceKind, string[]> = {
  vibe_memory: [
    "The raw conversation is evidence, not approved knowledge.",
    "Keep durable user preferences, repo operating rules, reusable procedures, and stable review constraints.",
    "Use agent diff entries only as evidence for a reusable rule/procedure, not as source code to copy.",
    "If the conversation mentions an external API, public URL, package behavior, or current documentation, verify it with tools before producing a candidate.",
  ],
  wiki: [
    "The wiki source is human-authored evidence, not already compile-ready knowledge.",
    "Compress long explanations, background, articles, and design notes into reusable rules/procedures.",
    "If the source cites a URL, public specification, API, package, or current behavior, verify it with tools before producing a candidate.",
  ],
};

export function buildDistillationSystemPrompt(
  sourceKind: DistillationSourceKind,
  extraLines: string[] = [],
): string {
  return [
    ...commonSystemLines(),
    "",
    ...sourceSpecificSystemLines[sourceKind],
    ...(extraLines.length > 0 ? ["", ...extraLines] : []),
  ].join("\n");
}
