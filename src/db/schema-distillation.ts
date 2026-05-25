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
  distillationQueueEventTypeValues,
  distillationQueueInputKindValues,
  distillationQueueMigrationStatusValues,
  distillationQueueNameValues,
  distillationQueueProducerValues,
  distillationQueueProviderPolicyValues,
  distillationQueueSourceKindValues,
  distillationQueueStatusValues,
  distillationTargetKindValues,
  distillationTargetPhaseValues,
  distillationTargetPriorityGroupValues,
  distillationTargetStatusValues,
  evidenceCoverageStatusValues,
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

export const findingCandidateQueue = pgTable(
  "finding_candidate_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inputKind: text("input_kind").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceUri: text("source_uri").notNull(),
    distillationVersion: text("distillation_version").notNull(),
    payload: jsonb("payload").default({}).notNull(),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRunAt: timestamp("next_run_at"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    queueUniqueIdx: uniqueIndex("finding_candidate_queue_unique_idx").on(
      table.inputKind,
      table.sourceKind,
      table.sourceKey,
      table.distillationVersion,
    ),
    statusPriorityCreatedAtIdx: index("finding_candidate_queue_status_priority_created_at_idx").on(
      table.status,
      table.priority,
      table.createdAt,
    ),
    statusCheck: check(
      "finding_candidate_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    inputKindCheck: check(
      "finding_candidate_queue_input_kind_check",
      sql`${table.inputKind} IN (${sql.raw(toSqlList(distillationQueueInputKindValues))})`,
    ),
    sourceKindCheck: check(
      "finding_candidate_queue_source_kind_check",
      sql`${table.sourceKind} IN (${sql.raw(toSqlList(distillationQueueSourceKindValues))})`,
    ),
    payloadObjectCheck: check(
      "finding_candidate_queue_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "finding_candidate_queue_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const foundCandidates = pgTable(
  "found_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingJobId: uuid("finding_job_id")
      .references(() => findingCandidateQueue.id, { onDelete: "cascade" })
      .notNull(),
    candidateIndex: integer("candidate_index").notNull(),
    type: text("type"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceSummary: text("source_summary"),
    origin: jsonb("origin").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    findingCandidateIdx: uniqueIndex("found_candidates_finding_candidate_unique_idx").on(
      table.findingJobId,
      table.candidateIndex,
    ),
    findingIdx: index("found_candidates_finding_job_idx").on(table.findingJobId),
    originObjectCheck: check(
      "found_candidates_origin_object_check",
      sql`jsonb_typeof(${table.origin}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "found_candidates_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    typeCheck: check(
      "found_candidates_type_check",
      sql`${table.type} IS NULL OR ${table.type} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
  }),
);

export const coveringEvidenceQueue = pgTable(
  "covering_evidence_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    foundCandidateId: uuid("found_candidate_id")
      .references(() => foundCandidates.id, { onDelete: "cascade" })
      .notNull(),
    distillationVersion: text("distillation_version").notNull(),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    providerPolicy: text("provider_policy").notNull().default("default"),
    nextRunAt: timestamp("next_run_at"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    payload: jsonb("payload").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    foundCandidateUniqueIdx: uniqueIndex("covering_evidence_queue_found_candidate_unique_idx").on(
      table.foundCandidateId,
    ),
    statusPriorityCreatedAtIdx: index("covering_evidence_queue_status_priority_created_at_idx").on(
      table.status,
      table.priority,
      table.createdAt,
    ),
    statusCheck: check(
      "covering_evidence_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    providerPolicyCheck: check(
      "covering_evidence_queue_provider_policy_check",
      sql`${table.providerPolicy} IN (${sql.raw(toSqlList(distillationQueueProviderPolicyValues))})`,
    ),
    payloadObjectCheck: check(
      "covering_evidence_queue_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "covering_evidence_queue_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const premiumCoveringEvidenceQueue = pgTable(
  "premium_covering_evidence_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    foundCandidateId: uuid("found_candidate_id")
      .references(() => foundCandidates.id, { onDelete: "cascade" })
      .notNull(),
    sourceCoveringJobId: uuid("source_covering_job_id").references(() => coveringEvidenceQueue.id, {
      onDelete: "set null",
    }),
    distillationVersion: text("distillation_version").notNull(),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    providerPolicy: text("provider_policy").notNull().default("cloud_api"),
    nextRunAt: timestamp("next_run_at"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    payload: jsonb("payload").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    foundCandidateUniqueIdx: uniqueIndex(
      "premium_covering_evidence_queue_found_candidate_unique_idx",
    ).on(table.foundCandidateId),
    statusPriorityCreatedAtIdx: index(
      "premium_covering_evidence_queue_status_priority_created_at_idx",
    ).on(table.status, table.priority, table.createdAt),
    statusCheck: check(
      "premium_covering_evidence_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    providerPolicyCheck: check(
      "premium_covering_evidence_queue_provider_policy_check",
      sql`${table.providerPolicy} IN (${sql.raw(toSqlList(distillationQueueProviderPolicyValues))})`,
    ),
    payloadObjectCheck: check(
      "premium_covering_evidence_queue_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "premium_covering_evidence_queue_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const evidenceCoverageResults = pgTable(
  "evidence_coverage_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    foundCandidateId: uuid("found_candidate_id")
      .references(() => foundCandidates.id, { onDelete: "cascade" })
      .notNull(),
    producerQueue: text("producer_queue").notNull(),
    producerJobId: uuid("producer_job_id").notNull(),
    distillationVersion: text("distillation_version").notNull(),
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
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    producerUniqueIdx: uniqueIndex(
      "evidence_coverage_results_found_candidate_producer_unique_idx",
    ).on(table.foundCandidateId, table.producerQueue),
    statusIdx: index("evidence_coverage_results_status_idx").on(table.status),
    producerCheck: check(
      "evidence_coverage_results_producer_queue_check",
      sql`${table.producerQueue} IN (${sql.raw(toSqlList(distillationQueueProducerValues))})`,
    ),
    statusCheck: check(
      "evidence_coverage_results_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(evidenceCoverageStatusValues))})`,
    ),
    stageCheck: check(
      "evidence_coverage_results_stage_check",
      sql`${table.stage} IN (${sql.raw(toSqlList(coverEvidenceStageValues))})`,
    ),
    typeCheck: check(
      "evidence_coverage_results_type_check",
      sql`${table.type} IS NULL OR ${table.type} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
    appliesToObjectCheck: check(
      "evidence_coverage_results_applies_to_object_check",
      sql`jsonb_typeof(${table.appliesTo}) = 'object'`,
    ),
    referencesArrayCheck: check(
      "evidence_coverage_results_references_array_check",
      sql`jsonb_typeof(${table.references}) = 'array'`,
    ),
    duplicateRefsArrayCheck: check(
      "evidence_coverage_results_duplicate_refs_array_check",
      sql`jsonb_typeof(${table.duplicateRefs}) = 'array'`,
    ),
    toolEventsArrayCheck: check(
      "evidence_coverage_results_tool_events_array_check",
      sql`jsonb_typeof(${table.toolEvents}) = 'array'`,
    ),
    metadataObjectCheck: check(
      "evidence_coverage_results_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const finalizeDistilleQueue = pgTable(
  "finalize_distille_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceResultId: uuid("evidence_result_id")
      .references(() => evidenceCoverageResults.id, { onDelete: "cascade" })
      .notNull(),
    distillationVersion: text("distillation_version").notNull(),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerPolicy: text("provider_policy").notNull().default("default"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    knowledgeId: uuid("knowledge_id"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    evidenceResultUniqueIdx: uniqueIndex("finalize_distille_queue_evidence_result_unique_idx").on(
      table.evidenceResultId,
    ),
    statusPriorityCreatedAtIdx: index("finalize_distille_queue_status_priority_created_at_idx").on(
      table.status,
      table.priority,
      table.createdAt,
    ),
    statusCheck: check(
      "finalize_distille_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    providerPolicyCheck: check(
      "finalize_distille_queue_provider_policy_check",
      sql`${table.providerPolicy} IN (${sql.raw(toSqlList(distillationQueueProviderPolicyValues))})`,
    ),
    metadataObjectCheck: check(
      "finalize_distille_queue_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const distillationQueueEvents = pgTable(
  "distillation_queue_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queueName: text("queue_name").notNull(),
    queueJobId: uuid("queue_job_id").notNull(),
    eventType: text("event_type").notNull(),
    message: text("message"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    queueNameEventTypeCreatedAtIdx: index("distillation_queue_events_name_type_created_at_idx").on(
      table.queueName,
      table.eventType,
      table.createdAt,
    ),
    queueNameCheck: check(
      "distillation_queue_events_queue_name_check",
      sql`${table.queueName} IN (${sql.raw(toSqlList(distillationQueueNameValues))})`,
    ),
    eventTypeCheck: check(
      "distillation_queue_events_event_type_check",
      sql`${table.eventType} IN (${sql.raw(toSqlList(distillationQueueEventTypeValues))})`,
    ),
    metadataObjectCheck: check(
      "distillation_queue_events_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const distillationQueueMigrationMap = pgTable(
  "distillation_queue_migration_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    legacyTargetStateId: uuid("legacy_target_state_id"),
    legacyFindCandidateResultId: uuid("legacy_find_candidate_result_id"),
    legacyCoverEvidenceResultId: uuid("legacy_cover_evidence_result_id"),
    legacyTargetKind: text("legacy_target_kind"),
    legacyTargetKey: text("legacy_target_key"),
    distillationVersion: text("distillation_version"),
    findingJobId: uuid("finding_job_id").references(() => findingCandidateQueue.id, {
      onDelete: "set null",
    }),
    foundCandidateId: uuid("found_candidate_id").references(() => foundCandidates.id, {
      onDelete: "set null",
    }),
    coveringJobId: uuid("covering_job_id").references(() => coveringEvidenceQueue.id, {
      onDelete: "set null",
    }),
    premiumJobId: uuid("premium_job_id").references(() => premiumCoveringEvidenceQueue.id, {
      onDelete: "set null",
    }),
    evidenceResultId: uuid("evidence_result_id").references(() => evidenceCoverageResults.id, {
      onDelete: "set null",
    }),
    finalizeJobId: uuid("finalize_job_id").references(() => finalizeDistilleQueue.id, {
      onDelete: "set null",
    }),
    migrationRunId: text("migration_run_id"),
    migrationStatus: text("migration_status").notNull().default("migrated"),
    skipReason: text("skip_reason"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    idempotencyUniqueIdx: uniqueIndex("distillation_queue_migration_map_idempotency_unique_idx").on(
      table.idempotencyKey,
    ),
    migrationStatusIdx: index("distillation_queue_migration_map_status_idx").on(
      table.migrationStatus,
    ),
    statusCheck: check(
      "distillation_queue_migration_map_status_check",
      sql`${table.migrationStatus} IN (${sql.raw(toSqlList(distillationQueueMigrationStatusValues))})`,
    ),
    metadataObjectCheck: check(
      "distillation_queue_migration_map_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);
