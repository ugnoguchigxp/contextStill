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
  vector,
} from "drizzle-orm/pg-core";
import { groupedConfig } from "../config.js";

export const knowledgeTypeValues = ["rule", "procedure"] as const;

export const knowledgeStatusValues = ["draft", "active", "deprecated"] as const;

export const scopeValues = ["repo", "global"] as const;

export const sourceKindValues = ["wiki"] as const;

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

export const vibeMemoryDistillationStatusValues = ["ok", "skipped", "failed"] as const;

export const vibeMemoryDistillationRuns = pgTable(
  "vibe_memory_distillation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vibeMemoryId: uuid("vibe_memory_id")
      .references(() => vibeMemories.id, {
        onDelete: "cascade",
      })
      .notNull(),
    status: text("status").notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    knowledgeIds: jsonb("knowledge_ids").default([]).notNull(),
    error: text("error"),
    inputHash: text("input_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    vibeMemoryIdIdx: index("vibe_memory_distillation_runs_memory_id_idx").on(table.vibeMemoryId),
    statusIdx: index("vibe_memory_distillation_runs_status_idx").on(table.status),
    promptVersionIdx: index("vibe_memory_distillation_runs_prompt_version_idx").on(
      table.promptVersion,
    ),
    memoryPromptHashIdx: uniqueIndex("vibe_memory_distillation_runs_memory_prompt_hash_idx").on(
      table.vibeMemoryId,
      table.promptVersion,
      table.inputHash,
    ),
    statusCheck: check(
      "vibe_memory_distillation_runs_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(vibeMemoryDistillationStatusValues))})`,
    ),
  }),
);

export const sourceDistillationStatusValues = ["ok", "skipped", "failed"] as const;

export const sourceLinkTypeValues = ["derived_from"] as const;

export const runStatusValues = ["ok", "degraded", "failed"] as const;

export const packSectionValues = ["rules", "procedures", "code_context", "warnings"] as const;

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

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastIndexedAt: timestamp("last_indexed_at"),
  },
  (table) => ({
    kindIdx: index("sources_kind_idx").on(table.sourceKind),
    uriUniqueIdx: uniqueIndex("sources_uri_unique_idx").on(table.uri),
    contentHashIdx: index("sources_content_hash_idx").on(table.contentHash),
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

export const sourceDistillationRuns = pgTable(
  "source_distillation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceFragmentId: uuid("source_fragment_id")
      .references(() => sourceFragments.id, {
        onDelete: "cascade",
      })
      .notNull(),
    status: text("status").notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    knowledgeIds: jsonb("knowledge_ids").default([]).notNull(),
    error: text("error"),
    inputHash: text("input_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    toolEvents: jsonb("tool_events").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    sourceFragmentIdIdx: index("source_distillation_runs_fragment_id_idx").on(
      table.sourceFragmentId,
    ),
    statusIdx: index("source_distillation_runs_status_idx").on(table.status),
    promptVersionIdx: index("source_distillation_runs_prompt_version_idx").on(table.promptVersion),
    fragmentPromptHashIdx: uniqueIndex("source_distillation_runs_fragment_prompt_hash_idx").on(
      table.sourceFragmentId,
      table.promptVersion,
      table.inputHash,
    ),
    statusCheck: check(
      "source_distillation_runs_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(sourceDistillationStatusValues))})`,
    ),
  }),
);

export const sourceDistillationEvidence = pgTable(
  "source_distillation_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => sourceDistillationRuns.id, { onDelete: "cascade" })
      .notNull(),
    toolName: text("tool_name").notNull(),
    url: text("url"),
    ok: integer("ok").notNull().default(0),
    contentHash: text("content_hash"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdIdx: index("source_distillation_evidence_run_id_idx").on(table.runId),
    toolNameIdx: index("source_distillation_evidence_tool_name_idx").on(table.toolName),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("context_compile_runs_status_idx").on(table.status),
    createdAtIdx: index("context_compile_runs_created_at_idx").on(table.createdAt),
    statusCheck: check(
      "context_compile_runs_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(runStatusValues))})`,
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
