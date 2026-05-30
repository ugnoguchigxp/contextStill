import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { groupedConfig } from "../config.js";
import { knowledgeItems } from "./schema-knowledge.js";
import {
  auditLogActorValues,
  compileEvalOutcomeValues,
  compileRunSourceValues,
  contextCompileCandidateTraceAgenticDecisionValues,
  contextCompileTaskTraceEmbeddingStatusValues,
  knowledgeReviewProposedActionValues,
  knowledgeReviewQueueStatusValues,
  knowledgeTypeValues,
  knowledgeUsageVerdictValues,
  packSectionValues,
  runStatusValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const contextCompileRuns = pgTable(
  "context_compile_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goal: text("goal").notNull(),
    intent: text("intent").notNull(),
    sessionId: text("session_id"),
    repoPath: text("repo_path"),
    input: jsonb("input").notNull().default({}),
    retrievalMode: text("retrieval_mode").notNull(),
    status: text("status").notNull(),
    degradedReasons: jsonb("degraded_reasons").notNull().default([]),
    tokenBudget: integer("token_budget").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    source: text("source").notNull().default("unknown"),
    packSnapshot: jsonb("pack_snapshot"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("context_compile_runs_status_idx").on(table.status),
    createdAtIdx: index("context_compile_runs_created_at_idx").on(table.createdAt),
    sessionCreatedAtIdx: index("context_compile_runs_session_created_at_idx")
      .on(table.sessionId, table.createdAt)
      .where(sql`${table.sessionId} is not null`),
    sourceIdx: index("context_compile_runs_source_idx").on(table.source),
    statusCheck: check(
      "context_compile_runs_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(runStatusValues))})`,
    ),
    sourceCheck: check(
      "context_compile_runs_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(compileRunSourceValues))})`,
    ),
  }),
);

export const contextCompileEvals = pgTable(
  "context_compile_evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    sessionId: text("session_id"),
    avg: integer("score").notNull(),
    outcome: text("outcome").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    source: text("source").notNull().default("mcp"),
    metadata: jsonb("metadata").notNull().default({}),
    relevance: integer("relevance"),
    actionability: integer("actionability"),
    coverage: integer("coverage"),
    clarity: integer("clarity"),
    specificity: integer("specificity"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runCreatedAtIdx: index("context_compile_evals_run_created_at_idx").on(
      table.runId,
      table.createdAt,
    ),
    sessionCreatedAtIdx: index("context_compile_evals_session_created_at_idx")
      .on(table.sessionId, table.createdAt)
      .where(sql`${table.sessionId} is not null`),
    outcomeCreatedAtIdx: index("context_compile_evals_outcome_created_at_idx").on(
      table.outcome,
      table.createdAt,
    ),
    scoreRangeCheck: check(
      "context_compile_evals_score_range_check",
      sql`${table.avg} >= 0 and ${table.avg} <= 100`,
    ),
    outcomeCheck: check(
      "context_compile_evals_outcome_check",
      sql`${table.outcome} IN (${sql.raw(toSqlList(compileEvalOutcomeValues))})`,
    ),
    sourceCheck: check(
      "context_compile_evals_source_check",
      sql`${table.source} IN ('mcp', 'ui', 'system', 'import')`,
    ),
    bodyLengthCheck: check(
      "context_compile_evals_body_length_check",
      sql`char_length(${table.body}) <= 10000`,
    ),
    titleLengthCheck: check(
      "context_compile_evals_title_length_check",
      sql`${table.title} is null or char_length(${table.title}) <= 160`,
    ),
    relevanceRangeCheck: check(
      "context_compile_evals_relevance_range_check",
      sql`${table.relevance} is null or (${table.relevance} >= 0 and ${table.relevance} <= 100)`,
    ),
    actionabilityRangeCheck: check(
      "context_compile_evals_actionability_range_check",
      sql`${table.actionability} is null or (${table.actionability} >= 0 and ${table.actionability} <= 100)`,
    ),
    coverageRangeCheck: check(
      "context_compile_evals_coverage_range_check",
      sql`${table.coverage} is null or (${table.coverage} >= 0 and ${table.coverage} <= 100)`,
    ),
    clarityRangeCheck: check(
      "context_compile_evals_clarity_range_check",
      sql`${table.clarity} is null or (${table.clarity} >= 0 and ${table.clarity} <= 100)`,
    ),
    specificityRangeCheck: check(
      "context_compile_evals_specificity_range_check",
      sql`${table.specificity} is null or (${table.specificity} >= 0 and ${table.specificity} <= 100)`,
    ),
  }),
);

export const contextCompileTaskTraces = pgTable(
  "context_compile_task_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    retrievalMode: text("retrieval_mode").notNull(),
    repoPath: text("repo_path"),
    repoKey: text("repo_key"),
    technologies: jsonb("technologies").notNull().default([]),
    changeTypes: jsonb("change_types").notNull().default([]),
    domains: jsonb("domains").notNull().default([]),
    embeddingStatus: text("embedding_status").notNull().default("facets_only"),
    embeddingProvider: text("embedding_provider"),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    goalHash: text("goal_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdUnique: uniqueIndex("context_compile_task_traces_run_id_unique").on(table.runId),
    createdAtIdx: index("context_compile_task_traces_created_at_idx").on(table.createdAt),
    repoPathIdx: index("context_compile_task_traces_repo_path_idx").on(table.repoPath),
    repoKeyIdx: index("context_compile_task_traces_repo_key_idx").on(table.repoKey),
    embeddingStatusIdx: index("context_compile_task_traces_embedding_status_idx").on(
      table.embeddingStatus,
    ),
    goalHashIdx: index("context_compile_task_traces_goal_hash_idx").on(table.goalHash),
    technologiesArrayCheck: check(
      "context_compile_task_traces_technologies_array_check",
      sql`jsonb_typeof(${table.technologies}) = 'array'`,
    ),
    changeTypesArrayCheck: check(
      "context_compile_task_traces_change_types_array_check",
      sql`jsonb_typeof(${table.changeTypes}) = 'array'`,
    ),
    domainsArrayCheck: check(
      "context_compile_task_traces_domains_array_check",
      sql`jsonb_typeof(${table.domains}) = 'array'`,
    ),
    embeddingStatusCheck: check(
      "context_compile_task_traces_embedding_status_check",
      sql`${table.embeddingStatus} IN (${sql.raw(
        toSqlList(contextCompileTaskTraceEmbeddingStatusValues),
      )})`,
    ),
  }),
);

export const contextPackItems = pgTable(
  "context_pack_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: text("item_id").notNull(),
    section: text("section").notNull(),
    score: real("score").default(0).notNull(),
    rankingReason: text("ranking_reason").notNull(),
    sourceRefs: jsonb("source_refs").notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdIdx: index("context_pack_items_run_id_idx").on(table.runId),
    sectionIdx: index("context_pack_items_section_idx").on(table.section),
    sectionCheck: check(
      "context_pack_items_section_check",
      sql`${table.section} IN (${sql.raw(toSqlList(packSectionValues))})`,
    ),
  }),
);

export const contextCompileCandidateTraces = pgTable(
  "context_compile_candidate_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: uuid("item_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    textRank: integer("text_rank"),
    textScore: real("text_score"),
    vectorRank: integer("vector_rank"),
    vectorScore: real("vector_score"),
    mergedRank: integer("merged_rank"),
    mergedScore: real("merged_score"),
    finalRank: integer("final_rank"),
    finalScore: real("final_score"),
    selected: boolean("selected").notNull().default(false),
    suppressed: boolean("suppressed").notNull().default(false),
    suppressionReason: text("suppression_reason"),
    agenticDecision: text("agentic_decision").notNull().default("not_evaluated"),
    rankingReason: text("ranking_reason"),
    communityKey: text("community_key"),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runItemUnique: uniqueIndex("context_compile_candidate_traces_run_item_unique").on(
      table.runId,
      table.itemKind,
      table.itemId,
    ),
    runFinalRankIdx: index("context_compile_candidate_traces_run_final_rank_idx").on(
      table.runId,
      table.finalRank,
    ),
    itemCreatedAtIdx: index("context_compile_candidate_traces_item_created_at_idx").on(
      table.itemId,
      table.createdAt,
    ),
    runSelectedIdx: index("context_compile_candidate_traces_run_selected_idx").on(
      table.runId,
      table.selected,
    ),
    suppressionReasonIdx: index("context_compile_candidate_traces_suppression_reason_idx").on(
      table.suppressionReason,
    ),
    communityKeyCreatedAtIdx: index(
      "context_compile_candidate_traces_community_key_created_at_idx",
    ).on(table.communityKey, table.createdAt),
    itemKindCheck: check(
      "context_compile_candidate_traces_item_kind_check",
      sql`${table.itemKind} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
    agenticDecisionCheck: check(
      "context_compile_candidate_traces_agentic_decision_check",
      sql`${table.agenticDecision} IN (${sql.raw(
        toSqlList(contextCompileCandidateTraceAgenticDecisionValues),
      )})`,
    ),
    evidenceObjectCheck: check(
      "context_compile_candidate_traces_evidence_object_check",
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
  }),
);

export const knowledgeUsageEvents = pgTable(
  "knowledge_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    verdict: text("verdict").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdIdx: index("knowledge_usage_events_run_id_idx").on(table.runId),
    knowledgeIdIdx: index("knowledge_usage_events_knowledge_id_idx").on(table.knowledgeId),
    verdictCreatedAtIdx: index("knowledge_usage_events_verdict_created_at_idx").on(
      table.verdict,
      table.createdAt,
    ),
    knowledgeVerdictCreatedAtIdx: index(
      "knowledge_usage_events_knowledge_verdict_created_at_idx",
    ).on(table.knowledgeId, table.verdict, table.createdAt),
    runKnowledgeUnique: uniqueIndex("knowledge_usage_events_run_knowledge_unique").on(
      table.runId,
      table.knowledgeId,
    ),
    verdictCheck: check(
      "knowledge_usage_events_verdict_check",
      sql`${table.verdict} IN (${sql.raw(toSqlList(knowledgeUsageVerdictValues))})`,
    ),
    actorCheck: check(
      "knowledge_usage_events_actor_check",
      sql`${table.actor} IN (${sql.raw(toSqlList(auditLogActorValues))})`,
    ),
    reasonLengthCheck: check(
      "knowledge_usage_events_reason_length_check",
      sql`${table.reason} IS NULL OR char_length(${table.reason}) <= 160`,
    ),
  }),
);

export const knowledgeReviewQueue = pgTable(
  "knowledge_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    triggerEventId: uuid("trigger_event_id")
      .references(() => knowledgeUsageEvents.id, { onDelete: "cascade" })
      .notNull(),
    triggerVerdict: text("trigger_verdict").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAction: text("proposed_action").notNull().default("review_only"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    statusCreatedAtIdx: index("knowledge_review_queue_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
    knowledgeStatusIdx: index("knowledge_review_queue_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    triggerEventUnique: uniqueIndex("knowledge_review_queue_trigger_event_unique").on(
      table.triggerEventId,
    ),
    triggerVerdictCheck: check(
      "knowledge_review_queue_trigger_verdict_check",
      sql`${table.triggerVerdict} IN (${sql.raw(toSqlList(knowledgeUsageVerdictValues))})`,
    ),
    statusCheck: check(
      "knowledge_review_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(knowledgeReviewQueueStatusValues))})`,
    ),
    proposedActionCheck: check(
      "knowledge_review_queue_proposed_action_check",
      sql`${table.proposedAction} IN (${sql.raw(toSqlList(knowledgeReviewProposedActionValues))})`,
    ),
  }),
);
