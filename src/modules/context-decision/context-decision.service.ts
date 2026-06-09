import {
  type ContextDecisionInput,
  type ContextDecisionResult,
  contextDecisionInputSchema,
} from "../../shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import { searchKnowledge } from "../knowledge/knowledge.repository.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";
import { buildDecisionCoverageQueries } from "./context-decision.coverage.js";
import {
  getContextDecisionDetail,
  getRelatedDecisionBadSignalCount,
  insertContextDecisionCoverageRows,
  insertContextDecisionEvidenceRows,
  insertContextDecisionRun,
  listContextDecisionRuns,
} from "./context-decision.repository.js";
import {
  type DecisionEvidenceCandidate,
  evidenceWeightAtDecision,
  resolveContextDecisionOutcome,
  scoreContextDecision,
} from "./context-decision.scoring.js";

function uniqueById(items: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const unique: KnowledgeSearchResult[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function summarizeKnowledge(item: KnowledgeSearchResult): string {
  const body = item.body.replace(/\s+/g, " ").trim();
  const excerpt = body.length > 280 ? `${body.slice(0, 277)}...` : body;
  return `${item.title}: ${excerpt}`;
}

function maxSimilarity(items: KnowledgeSearchResult[]): number | null {
  if (items.length === 0) return null;
  return Math.round(Math.max(...items.map((item) => Number(item.score) || 0)) * 100);
}

function buildGuardrails(input: ContextDecisionInput, riskEvidence: KnowledgeSearchResult[]) {
  return {
    retrievalHints: input.retrievalHints,
    riskEvidenceCount: riskEvidence.length,
  };
}

function compactLines(values: string[]): string {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(", ") : "none";
}

function fallbackAgentMessage(params: {
  decision: string;
  confidence: number;
  supportHits: number;
  counterHits: number;
  riskHits: number;
  status: string;
}): string {
  if (params.decision === "escalate") {
    return `判断は escalate です。自律実行に必要なKnowledge根拠が不足しているため、ユーザー確認に進むべき状態です。confidenceは${params.confidence}%で、support hitsは${params.supportHits}、counter evidence hitsは${params.counterHits}、risk hitsは${params.riskHits}です。`;
  }
  return `判断は ${params.decision} です。Knowledge検索ではsupport hitsが${params.supportHits}件、counter evidence hitsが${params.counterHits}件、risk hitsが${params.riskHits}件で、confidenceは${params.confidence}%です。statusは${params.status}で、この範囲では自律的に次へ進めます。`;
}

function normalizeAgentMessage(content: string, fallback: string): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return fallback;
  return normalized.length > 1200 ? `${normalized.slice(0, 1197)}...` : normalized;
}

async function composeAgentMessage(params: {
  input: ContextDecisionInput;
  decision: string;
  mandate: string;
  confidence: number;
  status: string;
  supportHits: number;
  preferenceHits: number;
  counterHits: number;
  riskHits: number;
  selectedSupportCount: number;
}): Promise<string> {
  const fallback = fallbackAgentMessage({
    decision: params.decision,
    confidence: params.confidence,
    supportHits: params.supportHits,
    counterHits: params.counterHits,
    riskHits: params.riskHits,
    status: params.status,
  });
  const providers = getAgenticLlmProviders(undefined, 12_000, "context-decision-answer");
  const systemPrompt = [
    "You are ContextStill Decision.",
    "Write the final decision answer for a coding agent.",
    "Do not inspect or cite evidence bodies. Use only the compact metrics supplied by the user.",
    "Answer in Japanese unless the decision point is clearly English.",
    "Keep it compact: 4 to 6 short sentences, no table, no JSON, no markdown heading.",
  ].join("\n");
  const userPrompt = [
    `Decision point: ${params.input.decisionPoint}`,
    `Decision: ${params.decision}`,
    `Mandate: ${params.mandate}`,
    `Confidence: ${params.confidence}%`,
    `Status: ${params.status}`,
    `Technologies: ${compactLines(params.input.retrievalHints.technologies)}`,
    `Change types: ${compactLines(params.input.retrievalHints.changeTypes)}`,
    `Domains: ${compactLines(params.input.retrievalHints.domains)}`,
    `Coverage: support=${params.supportHits}, preference=${params.preferenceHits}, counter=${params.counterHits}, risk=${params.riskHits}, selectedSupport=${params.selectedSupportCount}`,
    "Write the answer as the text shown at the top of the Decision screen and returned by the MCP tool.",
  ].join("\n");

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    try {
      const response = await provider.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 512,
        temperature: 0,
        responseFormat: "text",
      });
      return normalizeAgentMessage(response.content, fallback);
    } catch {}
  }
  return fallback;
}

export async function decideContext(input: unknown): Promise<ContextDecisionResult> {
  const parsed = contextDecisionInputSchema.parse(input);
  const coverageQueries = buildDecisionCoverageQueries(parsed);
  const coverageResults = await Promise.all(
    coverageQueries.map(async (query) => {
      const hits = await searchKnowledge(
        {
          query: query.query,
          status: "active",
          limit: 6,
          includeDraft: false,
          includeGeneral: true,
        },
        {
          includeGeneral: true,
          technologies: parsed.retrievalHints.technologies,
          changeTypes: parsed.retrievalHints.changeTypes,
          domains: parsed.retrievalHints.domains,
        },
      );
      return { ...query, hits: uniqueById(hits) };
    }),
  );

  const supportHits = coverageResults.find((item) => item.queryRole === "support")?.hits ?? [];
  const preferenceHits =
    coverageResults.find((item) => item.queryRole === "user_preference")?.hits ?? [];
  const riskHits = coverageResults.find((item) => item.queryRole === "risk")?.hits ?? [];
  const counterHits =
    coverageResults.find((item) => item.queryRole === "counter_evidence")?.hits ?? [];

  const selectedSupport = supportHits.slice(0, 4);
  const selectedPreference = preferenceHits.slice(0, 2);
  const selectedRisk = riskHits.slice(0, 2);
  const evidenceCandidates: DecisionEvidenceCandidate[] = [
    ...selectedSupport.map((knowledge) => ({
      knowledge,
      role: "selected_support" as const,
    })),
    ...selectedPreference.map((knowledge) => ({
      knowledge,
      role: "user_preference" as const,
    })),
    ...selectedRisk.map((knowledge) => ({
      knowledge,
      role: "risk_warning" as const,
    })),
  ];

  const relatedBadSignalCount = await getRelatedDecisionBadSignalCount(
    selectedSupport.map((item) => item.id),
  );
  const scored = scoreContextDecision({
    input: parsed,
    evidence: evidenceCandidates,
    coverage: coverageResults.map((item) => ({
      queryRole: item.queryRole,
      hitCount: item.hits.length,
    })),
    relatedBadSignalCount,
  });

  const selectedAction = null;
  const rejectedActions: string[] = [];
  const decision = resolveContextDecisionOutcome({
    selectedAction,
    confidence: scored.confidence,
  });
  const mandate =
    decision === "escalate"
      ? "Escalate only because required Knowledge evidence was not sufficient for autonomous progress."
      : `Proceed with: ${selectedAction ?? "the best supported autonomous action"}.`;
  const unsupportedAlternatives: Array<Record<string, unknown>> = [];
  const guardrails = buildGuardrails(parsed, selectedRisk);
  const agentMessage = await composeAgentMessage({
    input: parsed,
    decision,
    mandate,
    confidence: scored.confidence,
    status: scored.status,
    supportHits: supportHits.length,
    preferenceHits: preferenceHits.length,
    counterHits: counterHits.length,
    riskHits: riskHits.length,
    selectedSupportCount: selectedSupport.length,
  });

  const decisionId = await insertContextDecisionRun({
    input: parsed,
    decision,
    selectedAction,
    rejectedActions,
    mandate,
    agentMessage,
    confidence: scored.confidence,
    confidenceTrace: scored.trace,
    guardrails,
    unsupportedAlternatives,
    status: scored.status,
  });

  await insertContextDecisionEvidenceRows(
    decisionId,
    evidenceCandidates.map(({ knowledge, role }) => ({
      knowledgeId: knowledge.id,
      role,
      weightAtDecision: evidenceWeightAtDecision(knowledge),
      dynamicScoreAtDecision: Math.round(knowledge.dynamicScore),
      applicabilityScore: Math.round(knowledge.applicabilityScore),
      temporalRelevance: knowledge.lastVerifiedAt ? 85 : 55,
      summary: summarizeKnowledge(knowledge),
      sourceRefs: knowledge.sourceRefs,
      metadata: {
        title: knowledge.title,
        type: knowledge.type,
        status: knowledge.status,
        score: knowledge.score,
        confidence: knowledge.confidence,
        importance: knowledge.importance,
      },
    })),
  );

  if (
    counterHits.length === 0 &&
    coverageResults.some((item) => item.queryRole === "counter_evidence")
  ) {
    await insertContextDecisionEvidenceRows(decisionId, [
      {
        knowledgeId: null,
        role: "missing_counter_evidence",
        weightAtDecision: 0,
        dynamicScoreAtDecision: null,
        applicabilityScore: null,
        temporalRelevance: null,
        summary:
          "No counter-evidence was found in the v1 multi-query coverage trace. This is recorded as weak context only, not positive proof.",
        sourceRefs: [],
        metadata: { neutral: true },
      },
    ]);
  }

  await insertContextDecisionCoverageRows(
    decisionId,
    coverageResults.map((item) => {
      const selectedKnowledgeIds =
        item.queryRole === "support"
          ? selectedSupport.map((knowledge) => knowledge.id)
          : item.queryRole === "user_preference"
            ? selectedPreference.map((knowledge) => knowledge.id)
            : item.queryRole === "risk"
              ? selectedRisk.map((knowledge) => knowledge.id)
              : [];
      return {
        query: item.query,
        queryRole: item.queryRole,
        scope: { knowledgeStatus: "active" },
        hitCount: item.hits.length,
        maxSimilarity: maxSimilarity(item.hits),
        selectedKnowledgeIds,
        rejectedKnowledgeIds: item.hits
          .map((knowledge) => knowledge.id)
          .filter((id) => !selectedKnowledgeIds.includes(id)),
        reason: item.reason,
      };
    }),
  );

  return {
    decisionId,
    decision,
    mandate,
    confidence: scored.confidence,
    agentMessage,
    feedbackHandle: {
      decisionId,
      tool: "context_decision_feedback",
    },
    coverageSummary: {
      queryCount: coverageResults.length,
      supportHits: supportHits.length,
      counterEvidenceHits: counterHits.length,
      degraded: scored.status !== "completed",
    },
  };
}

export { getContextDecisionDetail, listContextDecisionRuns };
