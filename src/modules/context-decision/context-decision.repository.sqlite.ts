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
import type {
  ContextDecisionMetrics,
  ContextDecisionMlTrainingRow,
} from "./context-decision.repository.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

type SqliteRunRow = {
  id: string;
  session_id: string | null;
  premise: string | null;
  decision_point: string;
  proposed_action: string | null;
  options: string;
  retrieval_hints: string;
  decision: string;
  selected_action: string | null;
  rejected_actions: string;
  mandate: string;
  agent_message: string;
  confidence: number;
  confidence_trace: string;
  autonomy_level: string;
  risk_budget: string;
  knowledge_policy: string;
  available_rollback: string | null;
  verification_plan: string | null;
  guardrails: string;
  unsupported_alternatives: string;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  human_feedback_value?: string | null;
};

type SqliteEvidenceRow = {
  id: string;
  decision_run_id: string;
  knowledge_id: string | null;
  role: string;
  weight_at_decision: number;
  dynamic_score_at_decision: number | null;
  applicability_score: number | null;
  temporal_relevance: number | null;
  summary: string;
  source_refs: string;
  metadata: string;
  created_at: string;
};

type SqliteCoverageRow = {
  id: string;
  decision_run_id: string;
  query: string;
  query_role: string;
  scope: string;
  hit_count: number;
  max_similarity: number | null;
  selected_knowledge_ids: string;
  rejected_knowledge_ids: string;
  reason: string;
  created_at: string;
};

type SqliteHumanFeedbackRow = {
  id: string;
  decision_run_id: string;
  value: string;
  created_at: string;
};

type SqliteFeedbackRow = {
  id: string;
  decision_run_id: string;
  source: string;
  outcome: string;
  inferred_reason: string;
  affected_knowledge_ids: string;
  suggested_adjustment: string;
  metadata: string;
  created_at: string;
};

type SqliteEffectRow = {
  id: string;
  feedback_id: string | null;
  human_feedback_id: string | null;
  decision_run_id: string;
  knowledge_id: string | null;
  effect: string;
  amount: number;
  reason: string;
  confidence: number;
  status: string;
  applied_at: string | null;
  metadata: string;
  created_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asStringArray(value: unknown): string[] {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(parsed)
    ? parsed.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function toIso(value: string | null): string {
  if (!value) return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
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

function normalizeRetrievalHints(value: unknown): ContextDecisionRetrievalHints {
  const record = asRecord(value);
  return {
    technologies: asStringArray(record.technologies),
    changeTypes: asStringArray(record.changeTypes),
    domains: asStringArray(record.domains),
  };
}

function mapRunSummary(row: SqliteRunRow): ContextDecisionRunSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    decisionPoint: row.decision_point,
    decision: normalizeDecision(row.decision),
    selectedAction: row.selected_action,
    mandate: row.mandate,
    confidence: row.confidence,
    status: normalizeStatus(row.status),
    humanFeedback: row.human_feedback_value
      ? normalizeHumanFeedbackValue(row.human_feedback_value)
      : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvidence(row: SqliteEvidenceRow): ContextDecisionEvidence {
  return {
    id: row.id,
    decisionRunId: row.decision_run_id,
    knowledgeId: row.knowledge_id,
    role: row.role as ContextDecisionEvidenceRole,
    weightAtDecision: row.weight_at_decision,
    dynamicScoreAtDecision: row.dynamic_score_at_decision,
    applicabilityScore: row.applicability_score,
    temporalRelevance: row.temporal_relevance,
    summary: row.summary,
    sourceRefs: asStringArray(row.source_refs),
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.created_at),
  };
}

function mapCoverage(row: SqliteCoverageRow): ContextDecisionCoverageTrace {
  return {
    id: row.id,
    decisionRunId: row.decision_run_id,
    query: row.query,
    queryRole: row.query_role as ContextDecisionCoverageQueryRole,
    scope: asRecord(row.scope),
    hitCount: row.hit_count,
    maxSimilarity: row.max_similarity,
    selectedKnowledgeIds: asStringArray(row.selected_knowledge_ids),
    rejectedKnowledgeIds: asStringArray(row.rejected_knowledge_ids),
    reason: row.reason,
    createdAt: toIso(row.created_at),
  };
}

function mapHumanFeedback(row: SqliteHumanFeedbackRow): ContextDecisionHumanFeedback {
  return {
    id: row.id,
    decisionRunId: row.decision_run_id,
    value: normalizeHumanFeedbackValue(row.value),
    createdAt: toIso(row.created_at),
  };
}

function mapFeedback(row: SqliteFeedbackRow): ContextDecisionFeedback {
  return {
    id: row.id,
    decisionRunId: row.decision_run_id,
    source: row.source as ContextDecisionFeedbackSource,
    outcome: row.outcome as ContextDecisionFeedbackOutcome,
    inferredReason: row.inferred_reason,
    affectedKnowledgeIds: asStringArray(row.affected_knowledge_ids),
    suggestedAdjustment: asRecord(row.suggested_adjustment),
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.created_at),
  };
}

function mapEffect(row: SqliteEffectRow): ContextDecisionFeedbackEffect {
  return {
    id: row.id,
    feedbackId: row.feedback_id,
    humanFeedbackId: row.human_feedback_id,
    decisionRunId: row.decision_run_id,
    knowledgeId: row.knowledge_id,
    effect: row.effect as ContextDecisionFeedbackEffect["effect"],
    amount: row.amount,
    reason: row.reason,
    confidence: row.confidence,
    status: row.status as ContextDecisionFeedbackEffectStatus,
    appliedAt: row.applied_at ? toIso(row.applied_at) : null,
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.created_at),
  };
}

export async function insertContextDecisionRunSqlite(params: {
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
  const sqlite = await getSqliteCoreDatabase();
  const id = crypto.randomUUID();
  const now = nowIso();
  sqlite.db
    .query(
      `
      insert into context_decision_runs (
        id, session_id, premise, decision_point, proposed_action, options,
        retrieval_hints, decision, selected_action, rejected_actions, mandate,
        agent_message, confidence, confidence_trace, autonomy_level, risk_budget,
        knowledge_policy, available_rollback, verification_plan, guardrails,
        unsupported_alternatives, status, metadata, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      params.input.sessionId ?? null,
      null,
      params.input.decisionPoint,
      null,
      "[]",
      json(params.input.retrievalHints),
      params.decision,
      params.selectedAction,
      jsonArray(params.rejectedActions),
      params.mandate,
      params.agentMessage,
      params.confidence,
      json(params.confidenceTrace),
      "high",
      "medium",
      "optional",
      null,
      null,
      json(params.guardrails),
      jsonArray(params.unsupportedAlternatives),
      params.status,
      json(params.input.metadata),
      now,
      now,
    );
  return id;
}

export async function markContextDecisionRunFailedSqlite(
  decisionRunId: string,
  params: {
    reason: string;
    stage: string;
    mandate: string;
    agentMessage: string;
  },
): Promise<void> {
  const sqlite = await getSqliteCoreDatabase();
  const current = sqlite.db
    .query<{ confidence_trace: string }, [string]>(
      "select confidence_trace from context_decision_runs where id = ?",
    )
    .get(decisionRunId);
  const confidenceTrace = {
    ...asRecord(current?.confidence_trace),
    postRunPersistenceFailure: {
      stage: params.stage,
      reason: params.reason,
      recordedAt: nowIso(),
    },
  };
  sqlite.db
    .query(
      `
      update context_decision_runs
      set decision = ?,
          selected_action = ?,
          rejected_actions = ?,
          mandate = ?,
          agent_message = ?,
          confidence = ?,
          confidence_trace = ?,
          status = ?,
          updated_at = ?
      where id = ?
    `,
    )
    .run(
      "escalate",
      null,
      jsonArray(["execute"]),
      params.mandate,
      params.agentMessage,
      0,
      json(confidenceTrace),
      "failed",
      nowIso(),
      decisionRunId,
    );
}

export async function insertContextDecisionEvidenceRowsSqlite(
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
  const sqlite = await getSqliteCoreDatabase();
  const stmt = sqlite.db.query(
    `
    insert into context_decision_evidence (
      id, decision_run_id, knowledge_id, role, weight_at_decision,
      dynamic_score_at_decision, applicability_score, temporal_relevance,
      summary, source_refs, metadata, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );
  const now = nowIso();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of items) {
      stmt.run(
        crypto.randomUUID(),
        decisionRunId,
        item.knowledgeId,
        item.role,
        item.weightAtDecision,
        item.dynamicScoreAtDecision,
        item.applicabilityScore,
        item.temporalRelevance,
        item.summary,
        jsonArray(item.sourceRefs),
        json(item.metadata),
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

export async function insertContextDecisionCoverageRowsSqlite(
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
  const sqlite = await getSqliteCoreDatabase();
  const stmt = sqlite.db.query(
    `
    insert into context_decision_coverage_traces (
      id, decision_run_id, query, query_role, scope, hit_count, max_similarity,
      selected_knowledge_ids, rejected_knowledge_ids, reason, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );
  const now = nowIso();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of items) {
      stmt.run(
        crypto.randomUUID(),
        decisionRunId,
        item.query,
        item.queryRole,
        json(item.scope),
        item.hitCount,
        item.maxSimilarity,
        jsonArray(item.selectedKnowledgeIds),
        jsonArray(item.rejectedKnowledgeIds),
        item.reason,
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

export async function getRelatedDecisionBadSignalSummarySqlite(knowledgeIds: string[]): Promise<{
  count: number;
  strongCount: number;
  averageConfidence: number;
  maxConfidence: number;
}> {
  if (knowledgeIds.length === 0) {
    return { count: 0, strongCount: 0, averageConfidence: 0, maxConfidence: 0 };
  }
  const sqlite = await getSqliteCoreDatabase();
  const placeholders = knowledgeIds.map(() => "?").join(", ");
  const row = sqlite.db
    .query<
      {
        count: number;
        strong_count: number;
        average_confidence: number;
        max_confidence: number;
      },
      string[]
    >(
      `
      select
        count(*) as count,
        sum(case when confidence >= 70 then 1 else 0 end) as strong_count,
        coalesce(round(avg(confidence)), 0) as average_confidence,
        coalesce(max(confidence), 0) as max_confidence
      from context_decision_feedback_effects
      where status = 'applied'
        and effect = 'penalize'
        and knowledge_id in (${placeholders})
    `,
    )
    .get(...knowledgeIds);
  return {
    count: Number(row?.count ?? 0),
    strongCount: Number(row?.strong_count ?? 0),
    averageConfidence: Number(row?.average_confidence ?? 0),
    maxConfidence: Number(row?.max_confidence ?? 0),
  };
}

export async function listContextDecisionRunsSqlite(
  query: ContextDecisionListQuery,
): Promise<ContextDecisionRunSummary[]> {
  const sqlite = await getSqliteCoreDatabase();
  const rows = sqlite.db
    .query<SqliteRunRow, []>(
      `
      select
        r.*,
        hf.value as human_feedback_value
      from context_decision_runs r
      left join context_decision_human_feedback hf on hf.decision_run_id = r.id
      order by r.created_at desc
      limit 500
    `,
    )
    .all()
    .filter((row) => !query.decision || row.decision === query.decision)
    .filter((row) => !query.status || row.status === query.status)
    .filter((row) => !query.cursor || row.created_at < query.cursor)
    .filter((row) => {
      const term = query.q?.trim().toLowerCase();
      if (!term) return true;
      return (
        row.decision_point.toLowerCase().includes(term) ||
        row.agent_message.toLowerCase().includes(term)
      );
    })
    .filter((row) => {
      if (query.feedback === "none") return !row.human_feedback_value;
      if (query.feedback) return row.human_feedback_value === query.feedback;
      return true;
    })
    .slice(0, query.limit);
  return rows.map(mapRunSummary);
}

export async function getContextDecisionDetailSqlite(
  decisionId: string,
): Promise<ContextDecisionRunDetail | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<SqliteRunRow, [string]>(
      `
      select
        r.*,
        hf.value as human_feedback_value
      from context_decision_runs r
      left join context_decision_human_feedback hf on hf.decision_run_id = r.id
      where r.id = ?
      limit 1
    `,
    )
    .get(decisionId);
  if (!row) return null;
  const humanFeedbackRows = sqlite.db
    .query<SqliteHumanFeedbackRow, [string]>(
      "select * from context_decision_human_feedback where decision_run_id = ?",
    )
    .all(decisionId);
  const evidenceRows = sqlite.db
    .query<SqliteEvidenceRow, [string]>(
      "select * from context_decision_evidence where decision_run_id = ?",
    )
    .all(decisionId);
  const coverageRows = sqlite.db
    .query<SqliteCoverageRow, [string]>(
      "select * from context_decision_coverage_traces where decision_run_id = ?",
    )
    .all(decisionId);
  const feedbackRows = sqlite.db
    .query<SqliteFeedbackRow, [string]>(
      "select * from context_decision_feedback where decision_run_id = ?",
    )
    .all(decisionId);
  const effectRows = sqlite.db
    .query<SqliteEffectRow, [string]>(
      "select * from context_decision_feedback_effects where decision_run_id = ?",
    )
    .all(decisionId);
  const humanFeedback = humanFeedbackRows[0]?.value
    ? normalizeHumanFeedbackValue(humanFeedbackRows[0].value)
    : null;
  return {
    run: {
      ...mapRunSummary({ ...row, human_feedback_value: humanFeedback }),
      rejectedActions: asStringArray(row.rejected_actions),
      retrievalHints: normalizeRetrievalHints(row.retrieval_hints),
      agentMessage: row.agent_message,
      confidenceTrace: asRecord(
        row.confidence_trace,
      ) as ContextDecisionRunDetail["run"]["confidenceTrace"],
      guardrails: asRecord(row.guardrails),
      unsupportedAlternatives: asObjectArray(row.unsupported_alternatives),
      metadata: asRecord(row.metadata),
    },
    evidence: evidenceRows.map(mapEvidence),
    coverage: coverageRows.map(mapCoverage),
    feedback: feedbackRows.map(mapFeedback),
    effects: effectRows.map(mapEffect),
  };
}

export async function saveHumanDecisionFeedbackSqlite(params: {
  decisionId: string;
  value: ContextDecisionHumanFeedbackValue;
  affectedKnowledgeIds: string[];
}): Promise<ContextDecisionHumanFeedback> {
  const sqlite = await getSqliteCoreDatabase();
  const now = nowIso();
  const existing = sqlite.db
    .query<SqliteHumanFeedbackRow, [string]>(
      "select * from context_decision_human_feedback where decision_run_id = ? limit 1",
    )
    .get(params.decisionId);
  const feedbackId = existing?.id ?? crypto.randomUUID();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    sqlite.db
      .query(
        `
        insert into context_decision_human_feedback (id, decision_run_id, value, created_at)
        values (?, ?, ?, ?)
        on conflict(decision_run_id) do update set value = excluded.value, created_at = excluded.created_at
      `,
      )
      .run(feedbackId, params.decisionId, params.value, now);
    sqlite.db
      .query("delete from context_decision_feedback_effects where human_feedback_id = ?")
      .run(feedbackId);
    if (params.affectedKnowledgeIds.length > 0) {
      const effect = params.value === "good" ? "boost" : "penalize";
      const amount = params.value === "good" ? 4 : -6;
      const stmt = sqlite.db.query(
        `
        insert into context_decision_feedback_effects (
          id, feedback_id, human_feedback_id, decision_run_id, knowledge_id,
          effect, amount, reason, confidence, status, applied_at, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      for (const knowledgeId of params.affectedKnowledgeIds) {
        stmt.run(
          crypto.randomUUID(),
          null,
          feedbackId,
          params.decisionId,
          knowledgeId,
          effect,
          amount,
          params.value === "good"
            ? "Human Good feedback for decision-driving evidence."
            : "Human Bad feedback for decision-driving evidence.",
          80,
          "applied",
          now,
          json({ source: "human_feedback" }),
          now,
        );
      }
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
  const row = sqlite.db
    .query<SqliteHumanFeedbackRow, [string]>(
      "select * from context_decision_human_feedback where id = ?",
    )
    .get(feedbackId);
  if (!row) throw new Error("failed to save context decision feedback");
  return mapHumanFeedback(row);
}

export async function insertDecisionSystemFeedbackSqlite(params: {
  decisionId: string;
  source: ContextDecisionFeedbackSource;
  outcome: ContextDecisionFeedbackOutcome;
  inferredReason: string;
  affectedKnowledgeIds: string[];
  suggestedAdjustment: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<ContextDecisionFeedback> {
  const sqlite = await getSqliteCoreDatabase();
  const id = crypto.randomUUID();
  sqlite.db
    .query(
      `
      insert into context_decision_feedback (
        id, decision_run_id, source, outcome, inferred_reason,
        affected_knowledge_ids, suggested_adjustment, metadata, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      params.decisionId,
      params.source,
      params.outcome,
      params.inferredReason,
      jsonArray(params.affectedKnowledgeIds),
      json(params.suggestedAdjustment),
      json(params.metadata),
      nowIso(),
    );
  const row = sqlite.db
    .query<SqliteFeedbackRow, [string]>("select * from context_decision_feedback where id = ?")
    .get(id);
  if (!row) throw new Error("failed to save context decision system feedback");
  return mapFeedback(row);
}

export async function insertDecisionFeedbackEffectsSqlite(params: {
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
  const sqlite = await getSqliteCoreDatabase();
  const ids: string[] = [];
  const stmt = sqlite.db.query(
    `
    insert into context_decision_feedback_effects (
      id, feedback_id, human_feedback_id, decision_run_id, knowledge_id,
      effect, amount, reason, confidence, status, applied_at, metadata, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );
  const now = nowIso();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const effect of params.effects) {
      const id = crypto.randomUUID();
      ids.push(id);
      stmt.run(
        id,
        params.feedbackId ?? null,
        params.humanFeedbackId ?? null,
        params.decisionId,
        effect.knowledgeId,
        effect.effect,
        effect.amount,
        effect.reason,
        effect.confidence,
        effect.status,
        effect.status === "applied" ? now : null,
        json(effect.metadata ?? {}),
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
  const placeholders = ids.map(() => "?").join(", ");
  return sqlite.db
    .query<SqliteEffectRow, string[]>(
      `select * from context_decision_feedback_effects where id in (${placeholders})`,
    )
    .all(...ids)
    .map(mapEffect);
}

export async function listSelectedSupportKnowledgeIdsSqlite(decisionId: string): Promise<string[]> {
  const sqlite = await getSqliteCoreDatabase();
  return sqlite.db
    .query<{ knowledge_id: string | null }, [string]>(
      `
      select knowledge_id
      from context_decision_evidence
      where decision_run_id = ? and role = 'selected_support'
    `,
    )
    .all(decisionId)
    .map((row) => row.knowledge_id)
    .filter((id): id is string => Boolean(id));
}

export async function listContextDecisionKnowledgeIdsByRolesSqlite(
  decisionId: string,
  roles: ContextDecisionEvidenceRole[],
): Promise<string[]> {
  if (roles.length === 0) return [];
  const sqlite = await getSqliteCoreDatabase();
  const placeholders = roles.map(() => "?").join(", ");
  const rows = sqlite.db
    .query<{ knowledge_id: string | null }, string[]>(
      `
      select knowledge_id
      from context_decision_evidence
      where decision_run_id = ?
        and role in (${placeholders})
    `,
    )
    .all(decisionId, ...roles);
  return Array.from(
    new Set(rows.map((row) => row.knowledge_id).filter((id): id is string => Boolean(id))),
  );
}

export async function listContextDecisionPrScanCandidatesSqlite(params: {
  since?: Date;
  limit?: number;
}): Promise<Array<{ id: string; metadata: Record<string, unknown>; createdAt: string }>> {
  const sqlite = await getSqliteCoreDatabase();
  return sqlite.db
    .query<{ id: string; metadata: string; created_at: string }, []>(
      `
      select id, metadata, created_at
      from context_decision_runs
      order by created_at desc
      limit 500
    `,
    )
    .all()
    .filter((row) => !params.since || new Date(row.created_at) >= params.since)
    .filter((row) => {
      const metadata = asRecord(row.metadata);
      return "prUrl" in metadata || "prNumber" in metadata || "branch" in metadata;
    })
    .slice(0, params.limit ?? 100)
    .map((row) => ({
      id: row.id,
      metadata: asRecord(row.metadata),
      createdAt: toIso(row.created_at),
    }));
}

export async function hasDiscardedPrFeedbackSqlite(decisionId: string): Promise<boolean> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<{ id: string }, [string]>(
      `
      select id
      from context_decision_feedback
      where decision_run_id = ? and outcome = 'discarded_pr'
      limit 1
    `,
    )
    .get(decisionId);
  return Boolean(row);
}

export async function listContextDecisionMlTrainingRowsSqlite(params: {
  limit: number;
  minCreatedAt?: Date;
}): Promise<ContextDecisionMlTrainingRow[]> {
  const sqlite = await getSqliteCoreDatabase();
  return sqlite.db
    .query<SqliteRunRow, []>(
      `
      select
        r.*,
        hf.value as human_feedback_value
      from context_decision_runs r
      left join context_decision_human_feedback hf on hf.decision_run_id = r.id
      order by r.created_at desc
      limit 500
    `,
    )
    .all()
    .filter((row) => !params.minCreatedAt || new Date(row.created_at) >= params.minCreatedAt)
    .slice(0, params.limit)
    .map((row) => {
      const outcomes = sqlite.db
        .query<{ outcome: string }, [string]>(
          "select outcome from context_decision_feedback where decision_run_id = ?",
        )
        .all(row.id)
        .map((item) => item.outcome as ContextDecisionFeedbackOutcome);
      return {
        decisionId: row.id,
        decision: normalizeDecision(row.decision),
        confidenceTrace: asRecord(row.confidence_trace),
        metadata: asRecord(row.metadata),
        humanFeedback: row.human_feedback_value
          ? normalizeHumanFeedbackValue(row.human_feedback_value)
          : null,
        systemOutcomes: outcomes,
        createdAt: toIso(row.created_at),
      };
    });
}

export async function getContextDecisionMetricsSqlite(): Promise<ContextDecisionMetrics> {
  const sqlite = await getSqliteCoreDatabase();
  const totalDecisions = Number(
    sqlite.db
      .query<{ count: number }, []>("select count(*) as count from context_decision_runs")
      .get()?.count ?? 0,
  );
  const decisionCounts = Object.fromEntries(
    sqlite.db
      .query<{ decision: string; count: number }, []>(
        "select decision, count(*) as count from context_decision_runs group by decision",
      )
      .all()
      .map((row) => [row.decision, Number(row.count)]),
  );
  const count = (sqlText: string) =>
    Number(sqlite.db.query<{ count: number }, []>(sqlText).get()?.count ?? 0);
  const escalateCount = decisionCounts.escalate ?? 0;
  return {
    totalDecisions,
    decisionCounts,
    escalateRate: totalDecisions > 0 ? escalateCount / totalDecisions : 0,
    goodFeedbackCount: count(
      "select count(*) as count from context_decision_human_feedback where value = 'good'",
    ),
    badFeedbackCount: count(
      "select count(*) as count from context_decision_human_feedback where value = 'bad'",
    ),
    prDiscardFeedbackCount: count(
      "select count(*) as count from context_decision_feedback where outcome = 'discarded_pr'",
    ),
    autoAppliedEffectsCount: count(
      "select count(*) as count from context_decision_feedback_effects where status = 'applied'",
    ),
    queuedEffectsCount: count(
      "select count(*) as count from context_decision_feedback_effects where status = 'queued_for_review'",
    ),
    degradedDecisionsCount: count(
      "select count(*) as count from context_decision_runs where status = 'degraded'",
    ),
    requiredZeroEvidenceCount: count(`
      select count(*) as count
      from context_decision_runs r
      where r.knowledge_policy = 'required'
        and r.status = 'degraded'
        and not exists (
          select 1
          from context_decision_evidence e
          where e.decision_run_id = r.id
            and e.role = 'selected_support'
        )
    `),
  };
}
