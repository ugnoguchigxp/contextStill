import { sql } from "drizzle-orm";
import {
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
} from "drizzle-orm/pg-core";
import {
  coverEvidenceStageValues,
  coverEvidenceStatusValues,
  distillationTargetKindValues,
  distillationTargetPhaseValues,
  distillationTargetPriorityGroupValues,
  distillationTargetStatusValues,
  findCandidateResultStatusValues,
  knowledgeTypeValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const distillationTargetStates = pgTable(
  "distillation_target_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetKind: text("target_kind").notNull(),
    targetKey: text("target_key").notNull(),
    sourceUri: text("source_uri").notNull(),
    distillationVersion: text("distillation_version").notNull(),
    status: text("status").notNull().default("pending"),
    phase: text("phase").notNull().default("selected"),
    priorityGroup: text("priority_group").notNull(),
    sortKey: text("sort_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    nextRetryAt: timestamp("next_retry_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    candidateCount: integer("candidate_count").notNull().default(0),
    knowledgeIds: jsonb("knowledge_ids").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    statusIdx: index("distillation_target_states_status_idx").on(table.status),
    kindStatusIdx: index("distillation_target_states_kind_status_idx").on(
      table.targetKind,
      table.status,
    ),
    prioritySelectIdx: index("distillation_target_states_priority_select_idx").on(
      table.priorityGroup,
      table.status,
      table.sortKey,
    ),
    heartbeatIdx: index("distillation_target_states_heartbeat_idx").on(table.heartbeatAt),
    nextRetryAtIdx: index("distillation_target_states_next_retry_at_idx").on(table.nextRetryAt),
    targetUniqueIdx: uniqueIndex("distillation_target_states_target_unique_idx").on(
      table.targetKind,
      table.targetKey,
      table.distillationVersion,
    ),
    targetKindCheck: check(
      "distillation_target_states_target_kind_check",
      sql`${table.targetKind} IN (${sql.raw(toSqlList(distillationTargetKindValues))})`,
    ),
    statusCheck: check(
      "distillation_target_states_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationTargetStatusValues))})`,
    ),
    phaseCheck: check(
      "distillation_target_states_phase_check",
      sql`${table.phase} IN (${sql.raw(toSqlList(distillationTargetPhaseValues))})`,
    ),
    priorityGroupCheck: check(
      "distillation_target_states_priority_group_check",
      sql`${table.priorityGroup} IN (${sql.raw(toSqlList(distillationTargetPriorityGroupValues))})`,
    ),
  }),
);

export const distillationEvidenceCache = pgTable(
  "distillation_evidence_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolName: text("tool_name").notNull(),
    queryText: text("query_text").notNull(),
    url: text("url"),
    ok: integer("ok").notNull().default(0),
    excerpt: text("excerpt"),
    metadata: jsonb("metadata").default({}).notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    toolNameIdx: index("distillation_evidence_cache_tool_name_idx").on(table.toolName),
    queryTextIdx: index("distillation_evidence_cache_query_text_idx").on(table.queryText),
    urlIdx: index("distillation_evidence_cache_url_idx").on(table.url),
    fetchedAtIdx: index("distillation_evidence_cache_fetched_at_idx").on(table.fetchedAt),
    lookupIdx: uniqueIndex("distillation_evidence_cache_lookup_idx").on(
      table.toolName,
      table.queryText,
      table.url,
    ),
  }),
);

export const findCandidateResults = pgTable(
  "find_candidate_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetStateId: uuid("target_state_id")
      .references(() => distillationTargetStates.id, {
        onDelete: "cascade",
      })
      .notNull(),
    candidateIndex: integer("candidate_index").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    origin: jsonb("origin").default({}).notNull(),
    status: text("status").notNull().default("selected"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    targetStateIdx: index("find_candidate_results_target_state_idx").on(table.targetStateId),
    targetCandidateIndexIdx: index("find_candidate_results_target_candidate_index_idx").on(
      table.targetStateId,
      table.candidateIndex,
    ),
    statusIdx: index("find_candidate_results_status_idx").on(table.status),
    statusCheck: check(
      "find_candidate_results_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(findCandidateResultStatusValues))})`,
    ),
  }),
);

export const coverEvidenceResults = pgTable(
  "cover_evidence_results",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => findCandidateResults.id, {
        onDelete: "cascade",
      })
      .notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull(),
    type: text("type"),
    title: text("title"),
    body: text("body"),
    importance: real("importance"),
    confidence: real("confidence"),
    appliesTo: jsonb("applies_to").default({}).notNull(),
    references: jsonb("references").default([]).notNull(),
    duplicateRefs: jsonb("duplicate_refs").default([]).notNull(),
    toolEvents: jsonb("tool_events").default([]).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("cover_evidence_results_status_idx").on(table.status),
    stageIdx: index("cover_evidence_results_stage_idx").on(table.stage),
    statusCheck: check(
      "cover_evidence_results_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(coverEvidenceStatusValues))})`,
    ),
    stageCheck: check(
      "cover_evidence_results_stage_check",
      sql`${table.stage} IN (${sql.raw(toSqlList(coverEvidenceStageValues))})`,
    ),
    typeCheck: check(
      "cover_evidence_results_type_check",
      sql`${table.type} IS NULL OR ${table.type} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
    reasonLengthCheck: check(
      "cover_evidence_results_reason_length_check",
      sql`${table.reason} IS NULL OR char_length(${table.reason}) <= 160`,
    ),
  }),
);
