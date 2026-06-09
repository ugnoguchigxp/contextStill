import {
  type ContextDecisionInput,
  type ContextDecisionResult,
  contextDecisionInputSchema,
} from "../../shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import { searchKnowledge } from "../knowledge/knowledge.repository.js";
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

function resolveSelectedAction(input: ContextDecisionInput): string | null {
  const proposed = input.proposedAction?.trim();
  if (proposed) return proposed;
  return input.options[0]?.trim() || null;
}

function resolveRejectedActions(
  input: ContextDecisionInput,
  selectedAction: string | null,
): string[] {
  return input.options.filter((option) => option.trim() && option.trim() !== selectedAction);
}

function maxSimilarity(items: KnowledgeSearchResult[]): number | null {
  if (items.length === 0) return null;
  return Math.round(Math.max(...items.map((item) => Number(item.score) || 0)) * 100);
}

function buildUnsupportedAlternatives(input: ContextDecisionInput, rejectedActions: string[]) {
  return rejectedActions.map((action) => ({
    action,
    reason: "No stronger Knowledge evidence was selected for this alternative in v1 scoring.",
  }));
}

function buildGuardrails(input: ContextDecisionInput, riskEvidence: KnowledgeSearchResult[]) {
  return {
    riskBudget: input.riskBudget,
    availableRollback: input.availableRollback ?? null,
    verificationPlan: input.verificationPlan ?? null,
    riskEvidenceCount: riskEvidence.length,
  };
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
    ...selectedSupport.map((knowledge) => ({ knowledge, role: "selected_support" as const })),
    ...selectedPreference.map((knowledge) => ({ knowledge, role: "user_preference" as const })),
    ...selectedRisk.map((knowledge) => ({ knowledge, role: "risk_warning" as const })),
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

  const selectedAction = resolveSelectedAction(parsed);
  const rejectedActions = resolveRejectedActions(parsed, selectedAction);
  const decision = resolveContextDecisionOutcome({
    input: parsed,
    selectedAction,
    confidence: scored.confidence,
  });
  const mandate =
    decision === "escalate"
      ? "Escalate only because required Knowledge evidence was not sufficient for autonomous progress."
      : `Proceed with: ${selectedAction ?? "the best supported autonomous action"}.`;
  const agentMessage =
    decision === "escalate"
      ? "ContextStill could not find enough Knowledge evidence to make this decision autonomously."
      : `ContextStill selected an autonomous ${decision} decision using ${selectedSupport.length} support evidence item(s).`;
  const unsupportedAlternatives = buildUnsupportedAlternatives(parsed, rejectedActions);
  const guardrails = buildGuardrails(parsed, selectedRisk);

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

  const detail = await getContextDecisionDetail(decisionId);
  const evidence = detail?.evidence ?? [];
  return {
    decisionId,
    decision,
    selected: selectedAction,
    rejected: rejectedActions,
    mandate,
    confidence: scored.confidence,
    agentMessage,
    guardrails,
    evidence,
    unsupportedAlternatives,
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
