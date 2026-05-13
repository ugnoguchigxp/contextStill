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
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { config } from "../config.js";

export const knowledgeTypeValues = [
  "fact",
  "decision",
  "rule",
  "procedure",
  "skill",
  "risk",
  "lesson",
  "example",
] as const;

export const knowledgeStatusValues = [
  "candidate",
  "draft",
  "trial",
  "active",
  "deprecated",
  "rejected",
] as const;

export const scopeValues = ["user", "repo", "workspace", "org", "global"] as const;

export const sourceKindValues = [
  "markdown",
  "session",
  "tool_output",
  "git",
  "web",
  "manual",
] as const;

export const relationTypeValues = [
  "supports",
  "derived_from",
  "contradicts",
  "supersedes",
  "applies_to",
  "mentions",
  "impacts",
] as const;

export const runStatusValues = ["ok", "degraded", "failed"] as const;

export const packSectionValues = [
  "rules",
  "skills",
  "examples",
  "code_context",
  "warnings",
  "evidence",
] as const;

const toSqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

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
    confidence: real("confidence").default(0.5).notNull(),
    importance: real("importance").default(0.5).notNull(),
    embedding: vector("embedding", { dimensions: config.embeddingDimension }),
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
    titleBodyFtsIdx: index("knowledge_items_title_body_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', concat_ws(' ', ${table.title}, ${table.body}))`,
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

export const evidenceSources = pgTable(
  "evidence_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    kindIdx: index("evidence_sources_kind_idx").on(table.sourceKind),
    uriIdx: index("evidence_sources_uri_idx").on(table.uri),
    uriHashIdx: index("evidence_sources_uri_hash_idx").on(table.uri, table.contentHash),
    sourceKindCheck: check(
      "evidence_sources_source_kind_check",
      sql`${table.sourceKind} IN (${sql.raw(toSqlList(sourceKindValues))})`,
    ),
  }),
);

export const evidenceFragments = pgTable(
  "evidence_fragments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => evidenceSources.id, { onDelete: "cascade" })
      .notNull(),
    locator: text("locator").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: config.embeddingDimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    sourceIdIdx: index("evidence_fragments_source_id_idx").on(table.sourceId),
    sourceLocatorIdx: index("evidence_fragments_source_locator_idx").on(
      table.sourceId,
      table.locator,
    ),
    contentFtsIdx: index("evidence_fragments_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    embeddingHnswIdx: index("evidence_fragments_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    relationType: text("relation_type").notNull(),
    confidence: real("confidence").default(0.5).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    sourceIdx: index("relations_source_idx").on(table.sourceKind, table.sourceId),
    targetIdx: index("relations_target_idx").on(table.targetKind, table.targetId),
    relationTypeIdx: index("relations_relation_type_idx").on(table.relationType),
    relationTypeCheck: check(
      "relations_relation_type_check",
      sql`${table.relationType} IN (${sql.raw(toSqlList(relationTypeValues))})`,
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
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
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

export const codeSymbols = pgTable(
  "code_symbols",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoPath: text("repo_path").notNull(),
    filePath: text("file_path").notNull(),
    symbolName: text("symbol_name").notNull(),
    symbolKind: text("symbol_kind").notNull(),
    signature: text("signature"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    metadata: jsonb("metadata").default({}).notNull(),
    embedding: vector("embedding", { dimensions: config.embeddingDimension }),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    repoFileIdx: index("code_symbols_repo_file_idx").on(table.repoPath, table.filePath),
    nameKindIdx: index("code_symbols_name_kind_idx").on(table.symbolName, table.symbolKind),
    activeIdx: index("code_symbols_active_idx").on(table.active),
    embeddingHnswIdx: index("code_symbols_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  }),
);
