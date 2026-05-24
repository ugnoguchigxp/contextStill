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

export const knowledgeTypeValues = ["rule", "procedure"] as const;

export const knowledgeStatusValues = ["draft", "active", "deprecated"] as const;

export const scopeValues = ["repo", "global"] as const;
export const knowledgeTagKindValues = [
  "technology",
  "change_type",
  "retrieval_mode",
  "domain",
] as const;
export const knowledgeTagStatusValues = ["active", "draft", "deprecated"] as const;

export const sourceKindValues = ["wiki"] as const;
export const settingValueKindValues = ["json", "string", "secret_ref", "encrypted"] as const;

export const vibeMemories = pgTable(
  "vibe_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    content: text("content").notNull(),
    memoryType: text("memory_type").notNull().default("chat"),
    dedupeKey: text("dedupe_key"),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    sessionIdIdx: index("vibe_memories_session_id_idx").on(table.sessionId),
    memoryTypeIdx: index("vibe_memories_memory_type_idx").on(table.memoryType),
    sessionDedupeKeyIdx: uniqueIndex("vibe_memories_session_dedupe_key_idx").on(
      table.sessionId,
      table.dedupeKey,
    ),
    contentFtsIdx: index("vibe_memories_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    embeddingHnswIdx: index("vibe_memories_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const syncStates = pgTable("sync_states", {
  id: text("id").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
  cursor: jsonb("cursor").default({}).notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull().default({}),
    valueKind: text("value_kind").notNull().default("json"),
    secretRef: text("secret_ref"),
    isSecret: boolean("is_secret").notNull().default(false),
    description: text("description"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => ({
    namespaceKeyUniqueIdx: uniqueIndex("settings_namespace_key_unique_idx").on(
      table.namespace,
      table.key,
    ),
    namespaceIdx: index("settings_namespace_idx").on(table.namespace),
    keyIdx: index("settings_key_idx").on(table.key),
    valueKindCheck: check(
      "settings_value_kind_check",
      sql`${table.valueKind} IN (${sql.raw(toSqlList(settingValueKindValues))})`,
    ),
  }),
);

export const agentDiffEntries = pgTable(
  "agent_diff_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vibeMemoryId: uuid("vibe_memory_id")
      .references(() => vibeMemories.id, {
        onDelete: "cascade",
      })
      .notNull(),
    filePath: text("file_path").notNull(),
    diffHunk: text("diff_hunk").notNull(),
    changeType: text("change_type"),
    language: text("language"),
    symbolName: text("symbol_name"),
    symbolKind: text("symbol_kind"),
    signature: text("signature"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    vibeMemoryIdIdx: index("agent_diff_entries_vibe_memory_id_idx").on(table.vibeMemoryId),
    filePathIdx: index("agent_diff_entries_file_path_idx").on(table.filePath),
    symbolIdx: index("agent_diff_entries_symbol_idx").on(table.symbolName, table.symbolKind),
    lineRangeIdx: index("agent_diff_entries_line_range_idx").on(table.startLine, table.endLine),
  }),
);

const toSqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

export const distillationTargetKindValues = [
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
] as const;

export const distillationTargetStatusValues = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "paused",
] as const;

export const distillationTargetPhaseValues = [
  "selected",
  "reading",
  "finding_candidate",
  "covering_evidence",
  "finalizing",
  "stored",
] as const;

export const distillationTargetPriorityGroupValues = [
  "knowledge_candidate",
  "wiki",
  "vibe_memory",
] as const;

export const findCandidateResultStatusValues = ["selected", "parse_failed"] as const;

export const coverEvidenceStatusValues = [
  "knowledge_ready",
  "duplicate",
  "near_duplicate",
  "insufficient",
  "reprocess_requested",
  "parse_failed",
  "tool_failed",
  "provider_failed",
] as const;

export const coverEvidenceStageValues = [
  "load",
  "source_support",
  "dedupe",
  "evidence_need",
  "web",
  "mcp",
  "final",
] as const;

export const sourceLinkTypeValues = ["derived_from"] as const;

export const runStatusValues = ["ok", "degraded", "failed"] as const;

export const compileRunSourceValues = ["ui", "mcp", "cli", "unknown"] as const;

export const packSectionValues = ["rules", "procedures", "code_context", "warnings"] as const;

export const knowledgeUsageVerdictValues = ["used", "not_used", "off_topic", "wrong"] as const;
export const knowledgeReviewQueueStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;
export const knowledgeReviewProposedActionValues = [
  "review_only",
  "demote_to_draft_candidate",
] as const;
export const landscapeReviewItemSourceValues = [
  "replay_compare",
  "landscape_snapshot",
  "semantic_relation_comparison",
  "promotion_gate",
] as const;
export const landscapeReviewItemReasonValues = [
  "used_baseline_lost",
  "baseline_off_topic",
  "baseline_wrong",
  "baseline_missing_after_recompile",
  "negative_attractor_candidate",
  "wrong_review_required",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
  "semantic_reachable_dead_zone",
  "semantic_split",
  "semantic_merge",
  "relation_orphan",
  "promotion_gate_review",
] as const;
export const landscapeReviewItemStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;
export const landscapeReviewItemProposedActionValues = [
  "review_only",
  "refine_applies_to",
  "repair_reachability",
  "review_wrong",
  "split_or_merge_review",
  "promotion_gate_review",
  "demote_to_draft_candidate",
] as const;
export const landscapeReviewItemConfidenceValues = ["low", "medium", "high"] as const;
export const knowledgeQualityAdjustmentKindValues = ["off_topic_quality_decrement"] as const;

export const auditLogActorValues = ["agent", "user", "system"] as const;

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    eventTypeIdx: index("audit_logs_event_type_idx").on(table.eventType),
    actorIdx: index("audit_logs_actor_idx").on(table.actor),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.createdAt),
    actorCheck: check(
      "audit_logs_actor_check",
      sql`${table.actor} IN (${sql.raw(toSqlList(auditLogActorValues))})`,
    ),
  }),
);

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    scope: text("scope").notNull().default("repo"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    appliesTo: jsonb("applies_to").default({}).notNull(),
    confidence: real("confidence").default(70).notNull(),
    importance: real("importance").default(70).notNull(),
    compileSelectCount: integer("compile_select_count").default(0).notNull(),
    lastCompiledAt: timestamp("last_compiled_at"),
    agenticAcceptCount: integer("agentic_accept_count").default(0).notNull(),
    explicitUpvoteCount: integer("explicit_upvote_count").default(0).notNull(),
    explicitDownvoteCount: integer("explicit_downvote_count").default(0).notNull(),
    dynamicScore: real("dynamic_score").default(0).notNull(),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
  },
  (table) => ({
    typeIdx: index("knowledge_items_type_idx").on(table.type),
    statusIdx: index("knowledge_items_status_idx").on(table.status),
    scopeIdx: index("knowledge_items_scope_idx").on(table.scope),
    typeStatusIdx: index("knowledge_items_type_status_idx").on(table.type, table.status),
    appliesToRepoKeyIdx: index("knowledge_items_applies_to_repo_key_idx").on(
      sql`${table.appliesTo} ->> 'repoKey'`,
    ),
    appliesToRepoPathIdx: index("knowledge_items_applies_to_repo_path_idx").on(
      sql`${table.appliesTo} ->> 'repoPath'`,
    ),
    appliesToGinIdx: index("knowledge_items_applies_to_gin_idx").using("gin", table.appliesTo),
    coverEvidenceResultIdIdx: index("knowledge_items_cover_evidence_result_id_idx").on(
      sql`${table.metadata} ->> 'coverEvidenceResultId'`,
    ),
    metadataSourceUriIdx: index("knowledge_items_metadata_source_uri_idx").on(
      sql`${table.metadata} ->> 'sourceUri'`,
    ),
    lastCompiledAtIdx: index("knowledge_items_last_compiled_at_idx").on(table.lastCompiledAt),
    dynamicScoreIdx: index("knowledge_items_dynamic_score_idx").on(table.dynamicScore),
    titleBodyFtsIdx: index("knowledge_items_title_body_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.title}, '') || ' ' || coalesce(${table.body}, ''))`,
    ),
    embeddingHnswIdx: index("knowledge_items_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    typeCheck: check(
      "knowledge_items_type_check",
      sql`${table.type} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
    statusCheck: check(
      "knowledge_items_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(knowledgeStatusValues))})`,
    ),
    scopeCheck: check(
      "knowledge_items_scope_check",
      sql`${table.scope} IN (${sql.raw(toSqlList(scopeValues))})`,
    ),
  }),
);

export const knowledgeCommunityLabels = pgTable(
  "knowledge_community_labels",
  {
    communityKey: text("community_key").primaryKey(),
    label: text("label").notNull(),
    note: text("note"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    updatedAtIdx: index("knowledge_community_labels_updated_at_idx").on(table.updatedAt),
  }),
);

export const knowledgeTagDefinitions = pgTable(
  "knowledge_tag_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    aliases: jsonb("aliases").default([]).notNull(),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(1000),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    kindStatusIdx: index("knowledge_tag_definitions_kind_status_idx").on(table.kind, table.status),
    aliasesGinIdx: index("knowledge_tag_definitions_aliases_gin_idx").using("gin", table.aliases),
    kindSlugUniqueIdx: uniqueIndex("knowledge_tag_definitions_kind_slug_unique").on(
      table.kind,
      table.slug,
    ),
    kindCheck: check(
      "knowledge_tag_definitions_kind_check",
      sql`${table.kind} IN (${sql.raw(toSqlList(knowledgeTagKindValues))})`,
    ),
    statusCheck: check(
      "knowledge_tag_definitions_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(knowledgeTagStatusValues))})`,
    ),
  }),
);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastIndexedAt: timestamp("last_indexed_at"),
  },
  (table) => ({
    kindIdx: index("sources_kind_idx").on(table.sourceKind),
    uriUniqueIdx: uniqueIndex("sources_uri_unique_idx").on(table.uri),
    sourceKindCheck: check(
      "sources_source_kind_check",
      sql`${table.sourceKind} IN (${sql.raw(toSqlList(sourceKindValues))})`,
    ),
    bodyFtsIdx: index("sources_body_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.body})`,
    ),
  }),
);

export const sourceFragments = pgTable(
  "source_fragments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    locator: text("locator").notNull(),
    heading: text("heading"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    sourceIdIdx: index("source_fragments_source_id_idx").on(table.sourceId),
    sourceLocatorIdx: index("source_fragments_source_locator_idx").on(
      table.sourceId,
      table.locator,
    ),
    contentFtsIdx: index("source_fragments_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    embeddingHnswIdx: index("source_fragments_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const knowledgeSourceLinks = pgTable(
  "knowledge_source_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    sourceFragmentId: uuid("source_fragment_id")
      .references(() => sourceFragments.id, { onDelete: "cascade" })
      .notNull(),
    linkType: text("link_type").notNull().default("derived_from"),
    confidence: real("confidence").default(0.5).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    knowledgeIdx: index("knowledge_source_links_knowledge_idx").on(table.knowledgeId),
    sourceFragmentIdx: index("knowledge_source_links_source_fragment_idx").on(
      table.sourceFragmentId,
    ),
    linkTypeIdx: index("knowledge_source_links_link_type_idx").on(table.linkType),
    linkTypeCheck: check(
      "knowledge_source_links_link_type_check",
      sql`${table.linkType} IN (${sql.raw(toSqlList(sourceLinkTypeValues))})`,
    ),
  }),
);

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

export const contextCompileRuns = pgTable(
  "context_compile_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goal: text("goal").notNull(),
    intent: text("intent").notNull(),
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

export const landscapeReviewItems = pgTable(
  "landscape_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAction: text("proposed_action").notNull().default("review_only"),
    priority: integer("priority").notNull().default(50),
    confidence: text("confidence").notNull().default("low"),
    idempotencyKey: text("idempotency_key").notNull(),
    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "cascade",
    }),
    runId: uuid("run_id").references(() => contextCompileRuns.id, {
      onDelete: "set null",
    }),
    triggerEventId: uuid("trigger_event_id").references(() => knowledgeUsageEvents.id, {
      onDelete: "set null",
    }),
    communityKey: text("community_key"),
    communityLabel: text("community_label"),
    suggestedAppliesTo: jsonb("suggested_applies_to").default({}).notNull(),
    evidence: jsonb("evidence").default([]).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("landscape_review_items_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    statusPriorityCreatedAtIdx: index("landscape_review_items_status_priority_created_at_idx").on(
      table.status,
      table.priority.desc(),
      table.createdAt,
    ),
    knowledgeStatusIdx: index("landscape_review_items_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    communityStatusIdx: index("landscape_review_items_community_status_idx").on(
      table.communityKey,
      table.status,
    ),
    runStatusIdx: index("landscape_review_items_run_status_idx").on(table.runId, table.status),
    reasonStatusIdx: index("landscape_review_items_reason_status_idx").on(
      table.reason,
      table.status,
    ),
    sourceCheck: check(
      "landscape_review_items_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(landscapeReviewItemSourceValues))})`,
    ),
    reasonCheck: check(
      "landscape_review_items_reason_check",
      sql`${table.reason} IN (${sql.raw(toSqlList(landscapeReviewItemReasonValues))})`,
    ),
    statusCheck: check(
      "landscape_review_items_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeReviewItemStatusValues))})`,
    ),
    proposedActionCheck: check(
      "landscape_review_items_proposed_action_check",
      sql`${table.proposedAction} IN (${sql.raw(
        toSqlList(landscapeReviewItemProposedActionValues),
      )})`,
    ),
    confidenceCheck: check(
      "landscape_review_items_confidence_check",
      sql`${table.confidence} IN (${sql.raw(toSqlList(landscapeReviewItemConfidenceValues))})`,
    ),
    priorityCheck: check(
      "landscape_review_items_priority_check",
      sql`${table.priority} >= 0 AND ${table.priority} <= 100`,
    ),
    evidenceArrayCheck: check(
      "landscape_review_items_evidence_array_check",
      sql`jsonb_typeof(${table.evidence}) = 'array'`,
    ),
    suggestedAppliesToObjectCheck: check(
      "landscape_review_items_suggested_applies_to_object_check",
      sql`jsonb_typeof(${table.suggestedAppliesTo}) = 'object'`,
    ),
    payloadObjectCheck: check(
      "landscape_review_items_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  }),
);

export const knowledgeQualityAdjustments = pgTable(
  "knowledge_quality_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    adjustmentKind: text("adjustment_kind").notNull(),
    windowStartAt: timestamp("window_start_at").notNull(),
    windowEndAt: timestamp("window_end_at").notNull(),
    negativeRunCount: integer("negative_run_count").notNull(),
    offTopicRate: real("off_topic_rate").notNull(),
    importanceDelta: real("importance_delta").notNull(),
    confidenceDelta: real("confidence_delta").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    knowledgeKindCreatedAtIdx: index(
      "knowledge_quality_adjustments_knowledge_kind_created_at_idx",
    ).on(table.knowledgeId, table.adjustmentKind, table.createdAt),
    createdAtIdx: index("knowledge_quality_adjustments_created_at_idx").on(table.createdAt),
    adjustmentKindCheck: check(
      "knowledge_quality_adjustments_adjustment_kind_check",
      sql`${table.adjustmentKind} IN (${sql.raw(toSqlList(knowledgeQualityAdjustmentKindValues))})`,
    ),
  }),
);

export const llmUsageLogs = pgTable(
  "llm_usage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // "local-llm" | "openai" | "bedrock" | "azure-openai"
    model: text("model").notNull(), // "gpt-4o", "gemma-4-e4b-it" などのモデル
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
    costJpy: real("cost_jpy").default(0).notNull(),
    usageMode: text("usage_mode").notNull().default("estimated"), // "measured" | "estimated"
    source: text("source").notNull().default("unknown"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("llm_usage_logs_created_at_idx").on(table.createdAt),
    providerIdx: index("llm_usage_logs_provider_idx").on(table.provider),
    sourceIdx: index("llm_usage_logs_source_idx").on(table.source),
    usageModeIdx: index("llm_usage_logs_usage_mode_idx").on(table.usageMode),
  }),
);
