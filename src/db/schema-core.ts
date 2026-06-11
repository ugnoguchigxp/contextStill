import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { groupedConfig } from "../config.js";
import { auditLogActorValues, settingValueKindValues } from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const vibeMigrationRuns = pgTable("vibe_migration_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromTable: text("from_table").notNull(),
  deletedCount: integer("deleted_count").notNull(),
  preservedTables: jsonb("preserved_tables").default([]).notNull(),
  executedAt: timestamp("executed_at").defaultNow().notNull(),
  appVersion: text("app_version").notNull(),
});

export const vibeGoals = pgTable("vibe_goals", {
  id: text("id").primaryKey(), // SHA-256 ハッシュ値。JOIN 用
  goalUri: text("goal_uri").notNull().unique(),
  goalAnchorRef: text("goal_anchor_ref").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
    // Legacy capsule columns retained for historical Vibe Memory rows.
    goalId: text("goal_id").references(() => vibeGoals.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): any => vibeMemories.id, { onDelete: "cascade" }),
    subject: text("subject"),
    intent: text("intent"),
    wants: jsonb("wants").default([]).notNull(),
    refs: jsonb("refs").default([]).notNull(),
    confidence: text("confidence"),
    evidenceStatus: text("evidence_status"),
    actorId: text("actor_id"),
    ttlAt: timestamp("ttl_at"),
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
    // Legacy capsule indexes retained until a separate physical cleanup migration.
    goalIdIdx: index("vibe_memories_goal_id_idx").on(table.goalId),
    parentIdIdx: index("vibe_memories_parent_id_idx").on(table.parentId),
    intentIdx: index("vibe_memories_intent_idx").on(table.intent),
  }),
);

export const vibeMemoryMarks = pgTable(
  "vibe_memory_marks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: text("goal_id")
      .references(() => vibeGoals.id, { onDelete: "cascade" })
      .notNull(),
    targetMemoryId: uuid("target_memory_id")
      .references(() => vibeMemories.id, { onDelete: "cascade" })
      .notNull(),
    mark: text("mark").notNull(),
    note: text("note"),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    goalIdIdx: index("vibe_memory_marks_goal_id_idx").on(table.goalId),
    targetMemoryIdIdx: index("vibe_memory_marks_target_memory_id_idx").on(table.targetMemoryId),
    markIdx: index("vibe_memory_marks_mark_idx").on(table.mark),
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
