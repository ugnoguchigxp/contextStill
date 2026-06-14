import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contextDecisionCoverageTraces,
  contextDecisionEvidence,
  contextDecisionFeedback,
  contextDecisionFeedbackEffects,
  contextDecisionHumanFeedback,
  contextDecisionRuns,
} from "../../db/schema.js";
import type {
  ContextDecisionCoverageQueryRole,
  ContextDecisionCoverageTrace,
  ContextDecisionEvidence,
  ContextDecisionEvidenceRole,
  ContextDecisionFeedback,
  ContextDecisionFeedbackEffect,
  ContextDecisionFeedbackEffectStatus,
  ContextDecisionFeedbackOutcome,
  ContextDecisionFeedbackSource,
  ContextDecisionHumanFeedback,
  ContextDecisionHumanFeedbackValue,
  ContextDecisionInput,
  ContextDecisionListQuery,
  ContextDecisionRetrievalHints,
  ContextDecisionRunDetail,
  ContextDecisionRunSummary,
  ContextDecisionStatus,
  ContextDecisionValue,
} from "../../shared/schemas/context-decision.schema.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function normalizeRetrievalHints(value: unknown): ContextDecisionRetrievalHints {
  const record = asRecord(value);
  return {
    technologies: asStringArray(record.technologies),
    changeTypes: asStringArray(record.changeTypes),
    domains: asStringArray(record.domains),
  };
}

function toIso(value: Date | string | null): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  if (!value) return null;
  return toIso(value);
}

function normalizeDecision(value: string): ContextDecisionValue {
  if (
    value === "execute" ||
    value === "reject" ||
    value === "revise_and_execute" ||
    value === "rollback" ||
    value === "discard" ||
    value === "escalate"
  ) {
    return value;
  }
  return "escalate";
}

function normalizeStatus(value: string): ContextDecisionStatus {
  if (value === "completed" || value === "degraded" || value === "failed") return value;
  return "failed";
}

function normalizeHumanFeedbackValue(value: string): ContextDecisionHumanFeedbackValue {
  return value === "bad" ? "bad" : "good";
}

export async function insertContextDecisionRun(params: {
  input: ContextDecisionInput;
  decision: ContextDecisionValue;
  selectedAction: string | null;
  rejectedActions: string[];
  mandate: string;
  agentMessage: string;
  confidence: number;
  confidenceTrace: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  unsupportedAlternatives: Array<Record<string, unknown>>;
  status: "completed" | "degraded" | "failed";
}): Promise<string> {
  const [inserted] = await db
    .insert(contextDecisionRuns)
    .values({
      sessionId: params.input.sessionId ?? null,
      premise: null,
      decisionPoint: params.input.decisionPoint,
      proposedAction: null,
      options: [],
      retrievalHints: params.input.retrievalHints,
      decision: params.decision,
      selectedAction: params.selectedAction,
      rejectedActions: params.rejectedActions,
      mandate: params.mandate,
      agentMessage: params.agentMessage,
      confidence: params.confidence,
      confidenceTrace: params.confidenceTrace,
      autonomyLevel: "high",
      riskBudget: "medium",
      knowledgePolicy: "optional",
      availableRollback: null,
      verificationPlan: null,
      guardrails: params.guardrails,
      unsupportedAlternatives: params.unsupportedAlternatives,
      status: params.status,
      metadata: params.input.metadata,
    })
    .returning({ id: contextDecisionRuns.id });
  return inserted.id;
}

export async function insertContextDecisionEvidenceRows(
  decisionRunId: string,
  items: Array<{
    knowledgeId: string | null;
    role: ContextDecisionEvidenceRole;
    weightAtDecision: number;
    dynamicScoreAtDecision: number | null;
    applicabilityScore: number | null;
    temporalRelevance: number | null;
    summary: string;
    sourceRefs: string[];
    metadata: Record<string, unknown>;
  }>,
): Promise<void> {
  if (items.length === 0) return;
  await db.insert(contextDecisionEvidence).values(
    items.map((item) => ({
      decisionRunId,
      knowledgeId: item.knowledgeId,
      role: item.role,
      weightAtDecision: item.weightAtDecision,
      dynamicScoreAtDecision: item.dynamicScoreAtDecision,
      applicabilityScore: item.applicabilityScore,
      temporalRelevance: item.temporalRelevance,
      summary: item.summary,
      sourceRefs: item.sourceRefs,
      metadata: item.metadata,
    })),
  );
}

export async function insertContextDecisionCoverageRows(
  decisionRunId: string,
  items: Array<{
    query: string;
    queryRole: ContextDecisionCoverageQueryRole;
    scope: Record<string, unknown>;
    hitCount: number;
    maxSimilarity: number | null;
    selectedKnowledgeIds: string[];
    rejectedKnowledgeIds: string[];
    reason: string;
  }>,
): Promise<void> {
  if (items.length === 0) return;
  await db.insert(contextDecisionCoverageTraces).values(
    items.map((item) => ({
      decisionRunId,
      query: item.query,
      queryRole: item.queryRole,
      scope: item.scope,
      hitCount: item.hitCount,
      maxSimilarity: item.maxSimilarity,
      selectedKnowledgeIds: item.selectedKnowledgeIds,
      rejectedKnowledgeIds: item.rejectedKnowledgeIds,
      reason: item.reason,
    })),
  );
}

export async function getRelatedDecisionBadSignalCount(knowledgeIds: string[]): Promise<number> {
  return (await getRelatedDecisionBadSignalSummary(knowledgeIds)).count;
}

export async function getRelatedDecisionBadSignalSummary(knowledgeIds: string[]): Promise<{
  count: number;
  strongCount: number;
  averageConfidence: number;
  maxConfidence: number;
}> {
  if (knowledgeIds.length === 0) {
    return { count: 0, strongCount: 0, averageConfidence: 0, maxConfidence: 0 };
  }
  const result = await db.execute(sql`
    select
      count(*)::int as count,
      count(*) filter (where confidence >= 70)::int as strong_count,
      coalesce(round(avg(confidence)), 0)::int as average_confidence,
      coalesce(max(confidence), 0)::int as max_confidence
    from context_decision_feedback_effects
    where status = 'applied'
      and effect = 'penalize'
      and knowledge_id in (${sql.join(
        knowledgeIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  const row = result.rows[0] as
    | {
        count?: number | string;
        strong_count?: number | string;
        average_confidence?: number | string;
        max_confidence?: number | string;
      }
    | undefined;
  return {
    count: Number(row?.count ?? 0),
    strongCount: Number(row?.strong_count ?? 0),
    averageConfidence: Number(row?.average_confidence ?? 0),
    maxConfidence: Number(row?.max_confidence ?? 0),
  };
}

function mapRunSummary(
  row: typeof contextDecisionRuns.$inferSelect & { humanFeedbackValue?: string | null },
): ContextDecisionRunSummary {
  return {
    id: row.id,
    sessionId: row.sessionId,
    decisionPoint: row.decisionPoint,
    decision: normalizeDecision(row.decision),
    selectedAction: row.selectedAction,
    mandate: row.mandate,
    confidence: row.confidence,
    status: normalizeStatus(row.status),
    humanFeedback: row.humanFeedbackValue
      ? normalizeHumanFeedbackValue(row.humanFeedbackValue)
      : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export async function listContextDecisionRuns(
  query: ContextDecisionListQuery,
): Promise<ContextDecisionRunSummary[]> {
  const conditions = [];
  if (query.decision) conditions.push(eq(contextDecisionRuns.decision, query.decision));
  if (query.status) conditions.push(eq(contextDecisionRuns.status, query.status));
  if (query.cursor) conditions.push(lt(contextDecisionRuns.createdAt, new Date(query.cursor)));
  if (query.q?.trim()) {
    const term = `%${query.q.trim()}%`;
    const textCondition = or(
      ilike(contextDecisionRuns.decisionPoint, term),
      ilike(contextDecisionRuns.agentMessage, term),
    );
    if (textCondition) conditions.push(textCondition);
  }
  if (query.feedback === "none") {
    conditions.push(sql`${contextDecisionHumanFeedback.id} is null`);
  } else if (query.feedback) {
    conditions.push(eq(contextDecisionHumanFeedback.value, query.feedback));
  }

  const rows = await db
    .select({
      id: contextDecisionRuns.id,
      sessionId: contextDecisionRuns.sessionId,
      premise: contextDecisionRuns.premise,
      decisionPoint: contextDecisionRuns.decisionPoint,
      proposedAction: contextDecisionRuns.proposedAction,
      options: contextDecisionRuns.options,
      retrievalHints: contextDecisionRuns.retrievalHints,
      decision: contextDecisionRuns.decision,
      selectedAction: contextDecisionRuns.selectedAction,
      rejectedActions: contextDecisionRuns.rejectedActions,
      mandate: contextDecisionRuns.mandate,
      agentMessage: contextDecisionRuns.agentMessage,
      confidence: contextDecisionRuns.confidence,
      confidenceTrace: contextDecisionRuns.confidenceTrace,
      autonomyLevel: contextDecisionRuns.autonomyLevel,
      riskBudget: contextDecisionRuns.riskBudget,
      knowledgePolicy: contextDecisionRuns.knowledgePolicy,
      availableRollback: contextDecisionRuns.availableRollback,
      verificationPlan: contextDecisionRuns.verificationPlan,
      guardrails: contextDecisionRuns.guardrails,
      unsupportedAlternatives: contextDecisionRuns.unsupportedAlternatives,
      status: contextDecisionRuns.status,
      metadata: contextDecisionRuns.metadata,
      createdAt: contextDecisionRuns.createdAt,
      updatedAt: contextDecisionRuns.updatedAt,
      humanFeedbackValue: contextDecisionHumanFeedback.value,
    })
    .from(contextDecisionRuns)
    .leftJoin(
      contextDecisionHumanFeedback,
      eq(contextDecisionHumanFeedback.decisionRunId, contextDecisionRuns.id),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(contextDecisionRuns.createdAt))
    .limit(query.limit);

  return rows.map((row) => mapRunSummary(row));
}

export async function getContextDecisionDetail(
  decisionId: string,
): Promise<ContextDecisionRunDetail | null> {
  const [row] = await db
    .select()
    .from(contextDecisionRuns)
    .where(eq(contextDecisionRuns.id, decisionId))
    .limit(1);
  if (!row) return null;

  const [humanFeedbackRows, evidenceRows, coverageRows, feedbackRows, effectRows] =
    await Promise.all([
      db
        .select()
        .from(contextDecisionHumanFeedback)
        .where(eq(contextDecisionHumanFeedback.decisionRunId, decisionId)),
      db
        .select()
        .from(contextDecisionEvidence)
        .where(eq(contextDecisionEvidence.decisionRunId, decisionId)),
      db
        .select()
        .from(contextDecisionCoverageTraces)
        .where(eq(contextDecisionCoverageTraces.decisionRunId, decisionId)),
      db
        .select()
        .from(contextDecisionFeedback)
        .where(eq(contextDecisionFeedback.decisionRunId, decisionId)),
      db
        .select()
        .from(contextDecisionFeedbackEffects)
        .where(eq(contextDecisionFeedbackEffects.decisionRunId, decisionId)),
    ]);

  const humanFeedback = humanFeedbackRows[0]?.value
    ? normalizeHumanFeedbackValue(humanFeedbackRows[0].value)
    : null;
  return {
    run: {
      ...mapRunSummary({ ...row, humanFeedbackValue: humanFeedback }),
      rejectedActions: asStringArray(row.rejectedActions),
      retrievalHints: normalizeRetrievalHints(row.retrievalHints),
      agentMessage: row.agentMessage,
      confidenceTrace: asRecord(
        row.confidenceTrace,
      ) as ContextDecisionRunDetail["run"]["confidenceTrace"],
      guardrails: asRecord(row.guardrails),
      unsupportedAlternatives: asObjectArray(row.unsupportedAlternatives),
      metadata: asRecord(row.metadata),
    },
    evidence: evidenceRows.map(mapEvidence),
    coverage: coverageRows.map(mapCoverage),
    feedback: feedbackRows.map(mapFeedback),
    effects: effectRows.map(mapEffect),
  };
}

function mapEvidence(row: typeof contextDecisionEvidence.$inferSelect): ContextDecisionEvidence {
  return {
    id: row.id,
    decisionRunId: row.decisionRunId,
    knowledgeId: row.knowledgeId,
    role: row.role as ContextDecisionEvidenceRole,
    weightAtDecision: row.weightAtDecision,
    dynamicScoreAtDecision: row.dynamicScoreAtDecision,
    applicabilityScore: row.applicabilityScore,
    temporalRelevance: row.temporalRelevance,
    summary: row.summary,
    sourceRefs: asStringArray(row.sourceRefs),
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.createdAt),
  };
}

function mapCoverage(
  row: typeof contextDecisionCoverageTraces.$inferSelect,
): ContextDecisionCoverageTrace {
  return {
    id: row.id,
    decisionRunId: row.decisionRunId,
    query: row.query,
    queryRole: row.queryRole as ContextDecisionCoverageQueryRole,
    scope: asRecord(row.scope),
    hitCount: row.hitCount,
    maxSimilarity: row.maxSimilarity,
    selectedKnowledgeIds: asStringArray(row.selectedKnowledgeIds),
    rejectedKnowledgeIds: asStringArray(row.rejectedKnowledgeIds),
    reason: row.reason,
    createdAt: toIso(row.createdAt),
  };
}

function mapHumanFeedback(
  row: typeof contextDecisionHumanFeedback.$inferSelect,
): ContextDecisionHumanFeedback {
  return {
    id: row.id,
    decisionRunId: row.decisionRunId,
    value: normalizeHumanFeedbackValue(row.value),
    createdAt: toIso(row.createdAt),
  };
}

function mapFeedback(row: typeof contextDecisionFeedback.$inferSelect): ContextDecisionFeedback {
  return {
    id: row.id,
    decisionRunId: row.decisionRunId,
    source: row.source as ContextDecisionFeedbackSource,
    outcome: row.outcome as ContextDecisionFeedbackOutcome,
    inferredReason: row.inferredReason,
    affectedKnowledgeIds: asStringArray(row.affectedKnowledgeIds),
    suggestedAdjustment: asRecord(row.suggestedAdjustment),
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.createdAt),
  };
}

function mapEffect(
  row: typeof contextDecisionFeedbackEffects.$inferSelect,
): ContextDecisionFeedbackEffect {
  return {
    id: row.id,
    feedbackId: row.feedbackId,
    humanFeedbackId: row.humanFeedbackId,
    decisionRunId: row.decisionRunId,
    knowledgeId: row.knowledgeId,
    effect: row.effect as ContextDecisionFeedbackEffect["effect"],
    amount: row.amount,
    reason: row.reason,
    confidence: row.confidence,
    status: row.status as ContextDecisionFeedbackEffectStatus,
    appliedAt: toNullableIso(row.appliedAt),
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.createdAt),
  };
}

export async function saveHumanDecisionFeedback(params: {
  decisionId: string;
  value: ContextDecisionHumanFeedbackValue;
  affectedKnowledgeIds: string[];
}): Promise<ContextDecisionHumanFeedback> {
  const [feedback] = await db
    .insert(contextDecisionHumanFeedback)
    .values({
      decisionRunId: params.decisionId,
      value: params.value,
    })
    .onConflictDoUpdate({
      target: contextDecisionHumanFeedback.decisionRunId,
      set: {
        value: params.value,
        createdAt: new Date(),
      },
    })
    .returning();

  await db
    .delete(contextDecisionFeedbackEffects)
    .where(eq(contextDecisionFeedbackEffects.humanFeedbackId, feedback.id));

  if (params.affectedKnowledgeIds.length > 0) {
    const effect = params.value === "good" ? "boost" : "penalize";
    const amount = params.value === "good" ? 4 : -6;
    await db.insert(contextDecisionFeedbackEffects).values(
      params.affectedKnowledgeIds.map((knowledgeId) => ({
        humanFeedbackId: feedback.id,
        decisionRunId: params.decisionId,
        knowledgeId,
        effect,
        amount,
        reason:
          params.value === "good"
            ? "Human Good feedback for selected decision support."
            : "Human Bad feedback for selected decision support.",
        confidence: 80,
        status: "applied",
        appliedAt: new Date(),
        metadata: { source: "human_feedback" },
      })),
    );
  }

  return mapHumanFeedback(feedback);
}

export async function insertDecisionSystemFeedback(params: {
  decisionId: string;
  source: ContextDecisionFeedbackSource;
  outcome: ContextDecisionFeedbackOutcome;
  inferredReason: string;
  affectedKnowledgeIds: string[];
  suggestedAdjustment: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<ContextDecisionFeedback> {
  const [feedback] = await db
    .insert(contextDecisionFeedback)
    .values({
      decisionRunId: params.decisionId,
      source: params.source,
      outcome: params.outcome,
      inferredReason: params.inferredReason,
      affectedKnowledgeIds: params.affectedKnowledgeIds,
      suggestedAdjustment: params.suggestedAdjustment,
      metadata: params.metadata,
    })
    .returning();
  return mapFeedback(feedback);
}

export async function insertDecisionFeedbackEffects(params: {
  feedbackId?: string;
  humanFeedbackId?: string;
  decisionId: string;
  effects: Array<{
    knowledgeId: string | null;
    effect: "boost" | "penalize" | "neutral";
    amount: number;
    reason: string;
    confidence: number;
    status: ContextDecisionFeedbackEffectStatus;
    metadata?: Record<string, unknown>;
  }>;
}): Promise<ContextDecisionFeedbackEffect[]> {
  if (params.effects.length === 0) return [];
  const rows = await db
    .insert(contextDecisionFeedbackEffects)
    .values(
      params.effects.map((effect) => ({
        feedbackId: params.feedbackId ?? null,
        humanFeedbackId: params.humanFeedbackId ?? null,
        decisionRunId: params.decisionId,
        knowledgeId: effect.knowledgeId,
        effect: effect.effect,
        amount: effect.amount,
        reason: effect.reason,
        confidence: effect.confidence,
        status: effect.status,
        appliedAt: effect.status === "applied" ? new Date() : null,
        metadata: effect.metadata ?? {},
      })),
    )
    .returning();
  return rows.map(mapEffect);
}

export async function listSelectedSupportKnowledgeIds(decisionId: string): Promise<string[]> {
  const rows = await db
    .select({ knowledgeId: contextDecisionEvidence.knowledgeId })
    .from(contextDecisionEvidence)
    .where(
      and(
        eq(contextDecisionEvidence.decisionRunId, decisionId),
        eq(contextDecisionEvidence.role, "selected_support"),
      ),
    );
  return rows.map((row) => row.knowledgeId).filter((id): id is string => Boolean(id));
}

export async function listContextDecisionPrScanCandidates(params: {
  since?: Date;
  limit?: number;
}): Promise<Array<{ id: string; metadata: Record<string, unknown>; createdAt: string }>> {
  const conditions = [sql`${contextDecisionRuns.metadata} ?| array['prUrl','prNumber','branch']`];
  if (params.since) conditions.push(sql`${contextDecisionRuns.createdAt} >= ${params.since}`);
  const rows = await db
    .select({
      id: contextDecisionRuns.id,
      metadata: contextDecisionRuns.metadata,
      createdAt: contextDecisionRuns.createdAt,
    })
    .from(contextDecisionRuns)
    .where(and(...conditions))
    .orderBy(desc(contextDecisionRuns.createdAt))
    .limit(params.limit ?? 100);
  return rows.map((row) => ({
    id: row.id,
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.createdAt),
  }));
}

export async function hasDiscardedPrFeedback(decisionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: contextDecisionFeedback.id })
    .from(contextDecisionFeedback)
    .where(
      and(
        eq(contextDecisionFeedback.decisionRunId, decisionId),
        eq(contextDecisionFeedback.outcome, "discarded_pr"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type ContextDecisionMetrics = {
  totalDecisions: number;
  decisionCounts: Record<string, number>;
  escalateRate: number;
  goodFeedbackCount: number;
  badFeedbackCount: number;
  prDiscardFeedbackCount: number;
  autoAppliedEffectsCount: number;
  queuedEffectsCount: number;
  degradedDecisionsCount: number;
  requiredZeroEvidenceCount: number;
};

export type ContextDecisionMlTrainingRow = {
  decisionId: string;
  decision: ContextDecisionValue;
  confidenceTrace: Record<string, unknown>;
  metadata: Record<string, unknown>;
  humanFeedback: ContextDecisionHumanFeedbackValue | null;
  systemOutcomes: ContextDecisionFeedbackOutcome[];
  createdAt: string;
};

export async function listContextDecisionMlTrainingRows(params: {
  limit: number;
  minCreatedAt?: Date;
}): Promise<ContextDecisionMlTrainingRow[]> {
  const conditions = [];
  if (params.minCreatedAt) {
    conditions.push(sql`${contextDecisionRuns.createdAt} >= ${params.minCreatedAt}`);
  }
  const rows = await db
    .select({
      id: contextDecisionRuns.id,
      decision: contextDecisionRuns.decision,
      confidenceTrace: contextDecisionRuns.confidenceTrace,
      metadata: contextDecisionRuns.metadata,
      createdAt: contextDecisionRuns.createdAt,
      humanFeedback: contextDecisionHumanFeedback.value,
      systemOutcomes: sql<unknown>`coalesce(
        jsonb_agg(${contextDecisionFeedback.outcome})
          filter (where ${contextDecisionFeedback.id} is not null),
        '[]'::jsonb
      )`,
    })
    .from(contextDecisionRuns)
    .leftJoin(
      contextDecisionHumanFeedback,
      eq(contextDecisionHumanFeedback.decisionRunId, contextDecisionRuns.id),
    )
    .leftJoin(
      contextDecisionFeedback,
      eq(contextDecisionFeedback.decisionRunId, contextDecisionRuns.id),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(contextDecisionRuns.id, contextDecisionHumanFeedback.value)
    .orderBy(desc(contextDecisionRuns.createdAt))
    .limit(params.limit);

  return rows.map((row) => ({
    decisionId: row.id,
    decision: normalizeDecision(row.decision),
    confidenceTrace: asRecord(row.confidenceTrace),
    metadata: asRecord(row.metadata),
    humanFeedback: row.humanFeedback ? normalizeHumanFeedbackValue(row.humanFeedback) : null,
    systemOutcomes: asStringArray(row.systemOutcomes).map(
      (outcome) => outcome as ContextDecisionFeedbackOutcome,
    ),
    createdAt: toIso(row.createdAt),
  }));
}

export async function getContextDecisionMetrics(): Promise<ContextDecisionMetrics> {
  const result = await db.execute(sql`
    select
      (select count(*)::int from context_decision_runs) as total_decisions,
      (select coalesce(jsonb_object_agg(decision, count), '{}'::jsonb)
       from (
         select decision, count(*)::int as count
         from context_decision_runs
         group by decision
       ) counts) as decision_counts,
      (select count(*)::int from context_decision_human_feedback where value = 'good') as good_feedback_count,
      (select count(*)::int from context_decision_human_feedback where value = 'bad') as bad_feedback_count,
      (select count(*)::int from context_decision_feedback where outcome = 'discarded_pr') as pr_discard_feedback_count,
      (select count(*)::int from context_decision_feedback_effects where status = 'applied') as auto_applied_effects_count,
      (select count(*)::int from context_decision_feedback_effects where status = 'queued_for_review') as queued_effects_count,
      (select count(*)::int from context_decision_runs where status = 'degraded') as degraded_decisions_count,
      (select count(*)::int
       from context_decision_runs r
       where r.knowledge_policy = 'required'
         and r.status = 'degraded'
         and not exists (
           select 1
           from context_decision_evidence e
           where e.decision_run_id = r.id
             and e.role = 'selected_support'
         )) as required_zero_evidence_count
  `);
  const row = result.rows[0] as
    | {
        total_decisions?: number | string;
        decision_counts?: Record<string, number>;
        good_feedback_count?: number | string;
        bad_feedback_count?: number | string;
        pr_discard_feedback_count?: number | string;
        auto_applied_effects_count?: number | string;
        queued_effects_count?: number | string;
        degraded_decisions_count?: number | string;
        required_zero_evidence_count?: number | string;
      }
    | undefined;
  const totalDecisions = Number(row?.total_decisions ?? 0);
  const rawDecisionCounts = asRecord(row?.decision_counts);
  const decisionCounts = Object.fromEntries(
    Object.entries(rawDecisionCounts).map(([key, value]) => [key, Number(value)]),
  );
  const escalateCount = decisionCounts.escalate ?? 0;
  return {
    totalDecisions,
    decisionCounts,
    escalateRate: totalDecisions > 0 ? escalateCount / totalDecisions : 0,
    goodFeedbackCount: Number(row?.good_feedback_count ?? 0),
    badFeedbackCount: Number(row?.bad_feedback_count ?? 0),
    prDiscardFeedbackCount: Number(row?.pr_discard_feedback_count ?? 0),
    autoAppliedEffectsCount: Number(row?.auto_applied_effects_count ?? 0),
    queuedEffectsCount: Number(row?.queued_effects_count ?? 0),
    degradedDecisionsCount: Number(row?.degraded_decisions_count ?? 0),
    requiredZeroEvidenceCount: Number(row?.required_zero_evidence_count ?? 0),
  };
}
