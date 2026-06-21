import type {
  ContextDecisionCoverageQueryRole,
  ContextDecisionEpisodePrecedent,
  ContextDecisionInput,
  ContextDecisionPrimaryEvidence,
  ContextDecisionRoleFit,
} from "../../shared/schemas/context-decision.schema.js";
import type { EpisodeCard } from "../../shared/schemas/episode-card.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";

const PRIMARY_EVIDENCE_KINDS = new Set<ContextDecisionPrimaryEvidence["kind"]>([
  "git_status",
  "verification_result",
  "file_state",
  "db_row",
  "runtime_log",
  "user_instruction",
  "other",
]);

const PRIMARY_EVIDENCE_STRENGTHS = new Set<ContextDecisionPrimaryEvidence["strength"]>([
  "verified",
  "observed",
  "claimed",
  "inferred",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
  "を",
  "が",
  "は",
  "に",
  "で",
  "と",
  "の",
  "へ",
  "から",
  "です",
  "ます",
]);

export type DecisionKnowledgeAnalysis = {
  topicalRelevanceScore: number;
  topicalRelevanceReason: string;
  topicalRelevanceCategory:
    | "direct_evidence"
    | "weak_background"
    | "off_topic"
    | "generic_guardrail";
  roleFit: ContextDecisionRoleFit;
};

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9_\u3040-\u30ff\u3400-\u9fff]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !STOP_WORDS.has(item));
  return new Set(tokens);
}

function overlapScore(contextTokens: Set<string>, candidateTokens: Set<string>): number {
  if (contextTokens.size === 0 || candidateTokens.size === 0) return 0;
  let hits = 0;
  for (const token of contextTokens) {
    if (candidateTokens.has(token)) hits += 1;
  }
  return clamp((hits / Math.min(contextTokens.size, 8)) * 45);
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function contextText(params: {
  input: ContextDecisionInput;
  primaryEvidence: ContextDecisionPrimaryEvidence[];
  episodePrecedents: ContextDecisionEpisodePrecedent[];
}): string {
  return [
    params.input.decisionPoint,
    ...params.input.retrievalHints.technologies,
    ...params.input.retrievalHints.changeTypes,
    ...params.input.retrievalHints.domains,
    ...params.primaryEvidence.flatMap((item) => [item.title, item.summary]),
    ...params.episodePrecedents.flatMap((item) => [item.title, item.situation, item.lesson]),
  ].join("\n");
}

export function extractDecisionPrimaryEvidence(
  input: ContextDecisionInput,
): ContextDecisionPrimaryEvidence[] {
  const raw = input.metadata.primaryEvidence;
  const items = Array.isArray(raw) ? raw : [];
  const parsed = items
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
    )
    .map((item): ContextDecisionPrimaryEvidence | null => {
      const kind = typeof item.kind === "string" ? item.kind : "other";
      const strength = typeof item.strength === "string" ? item.strength : "claimed";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const summary = typeof item.summary === "string" ? item.summary.trim() : "";
      if (!title || !summary) return null;
      return {
        kind: PRIMARY_EVIDENCE_KINDS.has(kind as ContextDecisionPrimaryEvidence["kind"])
          ? (kind as ContextDecisionPrimaryEvidence["kind"])
          : "other",
        title,
        summary,
        strength: PRIMARY_EVIDENCE_STRENGTHS.has(
          strength as ContextDecisionPrimaryEvidence["strength"],
        )
          ? (strength as ContextDecisionPrimaryEvidence["strength"])
          : "claimed",
        sourceRef:
          typeof item.sourceRef === "string" && item.sourceRef.trim()
            ? item.sourceRef.trim()
            : undefined,
        metadata:
          item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
            ? (item.metadata as Record<string, unknown>)
            : undefined,
      };
    })
    .filter((item): item is ContextDecisionPrimaryEvidence => item !== null);

  if (parsed.length > 0) return parsed.slice(0, 8);

  return [
    {
      kind: "user_instruction",
      title: "Decision point",
      summary: input.decisionPoint,
      strength: "inferred",
      metadata: { source: "decision_point" },
    },
  ];
}

export function scoreEpisodeTopicalRelevance(
  input: ContextDecisionInput,
  episode: EpisodeCard,
): number {
  const contextTokens = tokenize(
    [
      input.decisionPoint,
      ...input.retrievalHints.technologies,
      ...input.retrievalHints.changeTypes,
      ...input.retrievalHints.domains,
    ].join("\n"),
  );
  const episodeTokens = tokenize(
    [
      episode.title,
      episode.situation,
      episode.action,
      episode.outcome,
      episode.lesson,
      ...episode.technologies,
      ...episode.changeTypes,
      ...episode.domains,
    ].join("\n"),
  );
  const facetScore =
    input.retrievalHints.technologies.filter((item) => episode.technologies.includes(item)).length *
      12 +
    input.retrievalHints.changeTypes.filter((item) => episode.changeTypes.includes(item)).length *
      12 +
    input.retrievalHints.domains.filter((item) => episode.domains.includes(item)).length * 12;
  return clamp(overlapScore(contextTokens, episodeTokens) + facetScore + (episode.score ?? 0) * 2);
}

export function toDecisionEpisodePrecedent(
  input: ContextDecisionInput,
  episode: EpisodeCard,
): ContextDecisionEpisodePrecedent {
  const topicalRelevanceScore = scoreEpisodeTopicalRelevance(input, episode);
  const usedFor: ContextDecisionEpisodePrecedent["usedFor"] =
    topicalRelevanceScore >= 70 &&
    episode.evidenceStatus !== "unverified" &&
    (episode.outcomeKind === "failure" || episode.outcomeKind === "mixed")
      ? "risk_cap"
      : episode.outcomeKind === "success" && episode.evidenceStatus !== "unverified"
        ? "support_hint"
        : "background";
  return {
    episodeId: episode.id,
    title: episode.title,
    situation: episode.situation,
    action: episode.action,
    outcome: episode.outcome,
    lesson: episode.lesson,
    outcomeKind: episode.outcomeKind,
    evidenceStatus: episode.evidenceStatus,
    topicalRelevanceScore,
    usedFor,
    refs: [
      `context-still://episodes/${episode.id}`,
      ...episode.refs
        .map((ref) => (ref.locator ? `${ref.refValue}#${ref.locator}` : ref.refValue))
        .filter(Boolean),
    ],
  };
}

export function analyzeDecisionKnowledge(params: {
  input: ContextDecisionInput;
  primaryEvidence: ContextDecisionPrimaryEvidence[];
  episodePrecedents: ContextDecisionEpisodePrecedent[];
  knowledge: KnowledgeSearchResult;
  queryRole: ContextDecisionCoverageQueryRole;
}): DecisionKnowledgeAnalysis {
  const contextTokens = tokenize(
    contextText({
      input: params.input,
      primaryEvidence: params.primaryEvidence,
      episodePrecedents: params.episodePrecedents,
    }),
  );
  const knowledgeText = [
    params.knowledge.title,
    params.knowledge.body,
    ...params.knowledge.intentTags,
    ...params.knowledge.sourceRefs,
  ].join("\n");
  const knowledgeTokens = tokenize(knowledgeText);
  const lowered = knowledgeText.toLowerCase();
  const keywordScore = overlapScore(contextTokens, knowledgeTokens);
  const retrievalScore = clamp((Number(params.knowledge.score) || 0) * 25);
  const applicabilityScore = clamp(params.knowledge.applicabilityScore * 0.28, 0, 18);
  const supportVerbScore = hasAny(lowered, [
    /\b(proceed|execute|continue|implement|use|prefer|recommended|safe)\b/,
    /進め|実行|実装|使用|推奨/,
  ])
    ? 12
    : 0;
  const riskVerbScore = hasAny(lowered, [
    /\b(do not|don't|never|block|risk|rollback|discard|fail|failure|confirm|verify|required)\b/,
    /禁止|失敗|確認|検証|リスク|戻|破棄|停止/,
  ])
    ? 12
    : 0;
  const topicalRelevanceScore = clamp(
    keywordScore + retrievalScore + applicabilityScore + Math.max(supportVerbScore, riskVerbScore),
  );
  const guardrail =
    params.knowledge.polarity === "negative" ||
    params.queryRole === "risk" ||
    hasAny(lowered, [
      /\b(guardrail|risk|verify|required|confirm|do not|never)\b/,
      /確認|検証|禁止/,
    ]);
  const topicalRelevanceCategory: DecisionKnowledgeAnalysis["topicalRelevanceCategory"] =
    topicalRelevanceScore >= 70
      ? "direct_evidence"
      : guardrail && topicalRelevanceScore >= 40
        ? "generic_guardrail"
        : topicalRelevanceScore >= 40
          ? "weak_background"
          : "off_topic";

  let roleFit: ContextDecisionRoleFit;
  if (topicalRelevanceCategory === "off_topic") {
    roleFit = {
      classification: "off_topic",
      confidence: 80,
      reason: "Knowledge has weak topical overlap with the decision point and evidence context.",
    };
  } else if (params.queryRole === "counter_evidence") {
    roleFit = {
      classification: "counter_evidence",
      confidence: 78,
      reason:
        "Retrieved for counter-evidence and has enough topical relevance to be contradictory context.",
    };
  } else if (params.queryRole === "risk" || params.knowledge.polarity === "negative") {
    roleFit = {
      classification: "direct_risk",
      confidence: 78,
      reason:
        "Negative or risk-scoped Knowledge should constrain the decision rather than support execution.",
    };
  } else if (
    hasAny(lowered, [/\b(verify|required|confirm|test|check)\b/, /検証|確認|必要/]) &&
    !hasAny(lowered, [/\b(proceed|execute|continue|safe)\b/, /進め|実行|続行/])
  ) {
    roleFit = {
      classification: "verification_requirement",
      confidence: 72,
      reason: "The Knowledge mainly describes a verification or confirmation condition.",
    };
  } else if (params.queryRole === "support" && topicalRelevanceScore >= 70) {
    roleFit = {
      classification: "direct_support",
      confidence: 76,
      reason:
        "Positive Knowledge directly overlaps the decision context and supports the proposed action.",
    };
  } else {
    roleFit = {
      classification: "procedural_background",
      confidence: 65,
      reason: "Knowledge is relevant background but does not directly support execution.",
    };
  }

  return {
    topicalRelevanceScore,
    topicalRelevanceReason: `token overlap=${keywordScore}, retrieval=${retrievalScore}, applicability=${applicabilityScore}`,
    topicalRelevanceCategory,
    roleFit,
  };
}
