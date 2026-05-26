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

export const sessionMemos = pgTable(
  "session_memos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    slot: integer("slot").notNull(),
    kind: text("kind").notNull().default("scratch"),
    label: text("label"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    source: text("source").notNull().default("mcp"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    slotRangeCheck: check(
      "session_memos_slot_range_check",
      sql`${table.slot} >= 0 and ${table.slot} < 40`,
    ),
    sourceCheck: check(
      "session_memos_source_check",
      sql`${table.source} in ('mcp', 'ui', 'system', 'import')`,
    ),
    kindLengthCheck: check(
      "session_memos_kind_length_check",
      sql`char_length(${table.kind}) <= 64`,
    ),
    bodyLengthCheck: check(
      "session_memos_body_length_check",
      sql`char_length(${table.body}) <= 10000`,
    ),
    activeSlotUniqueIdx: uniqueIndex("session_memos_active_slot_unique")
      .on(table.sessionId, table.slot)
      .where(sql`${table.deletedAt} is null`),
    activeLabelUniqueIdx: uniqueIndex("session_memos_active_label_unique")
      .on(table.sessionId, sql`lower(${table.label})`)
      .where(sql`${table.deletedAt} is null and ${table.label} is not null`),
    sessionUpdatedAtIdx: index("session_memos_session_updated_at_idx").on(
      table.sessionId,
      table.updatedAt,
    ),
    sessionKindUpdatedAtIdx: index("session_memos_session_kind_updated_at_idx")
      .on(table.sessionId, table.kind, table.updatedAt)
      .where(sql`${table.deletedAt} is null`),
    expiresAtIdx: index("session_memos_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.deletedAt} is null and ${table.expiresAt} is not null`),
  }),
);

export const sessionMemoEvents = pgTable(
  "session_memo_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    slot: integer("slot"),
    kind: text("kind").notNull().default("scratch"),
    label: text("label"),
    action: text("action").notNull(),
    bodyPreview: text("body_preview"),
    metadata: jsonb("metadata").default({}).notNull(),
    source: text("source").notNull().default("mcp"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    actionCheck: check(
      "session_memo_events_action_check",
      sql`${table.action} in ('put', 'delete', 'clear', 'expire')`,
    ),
    sourceCheck: check(
      "session_memo_events_source_check",
      sql`${table.source} in ('mcp', 'ui', 'system', 'import')`,
    ),
    kindLengthCheck: check(
      "session_memo_events_kind_length_check",
      sql`char_length(${table.kind}) <= 64`,
    ),
    sessionCreatedAtIdx: index("session_memo_events_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    sessionKindCreatedAtIdx: index("session_memo_events_session_kind_created_at_idx").on(
      table.sessionId,
      table.kind,
      table.createdAt,
    ),
  }),
);
