import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sqliteKnowledgeItems = sqliteTable(
  "knowledge_items",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    scope: text("scope").notNull().default("repo"),
    polarity: text("polarity").notNull().default("positive"),
    intentTags: text("intent_tags", { mode: "json" }).$type<unknown[]>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    appliesTo: text("applies_to", { mode: "json" }).$type<unknown>().notNull(),
    confidence: real("confidence").notNull().default(70),
    importance: real("importance").notNull().default(70),
    compileSelectCount: integer("compile_select_count").notNull().default(0),
    lastCompiledAt: text("last_compiled_at"),
    agenticAcceptCount: integer("agentic_accept_count").notNull().default(0),
    explicitUpvoteCount: integer("explicit_upvote_count").notNull().default(0),
    explicitDownvoteCount: integer("explicit_downvote_count").notNull().default(0),
    dynamicScore: real("dynamic_score").notNull().default(0),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastVerifiedAt: text("last_verified_at"),
  },
  (table) => [
    index("knowledge_items_status_idx").on(table.status),
    index("knowledge_items_type_status_idx").on(table.type, table.status),
    index("knowledge_items_polarity_idx").on(table.polarity),
    index("knowledge_items_dynamic_score_idx").on(table.dynamicScore),
    index("knowledge_items_last_compiled_at_idx").on(table.lastCompiledAt),
  ],
);

export const sqliteKnowledgeTagDefinitions = sqliteTable(
  "knowledge_tag_definitions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    aliases: text("aliases", { mode: "json" }).$type<unknown[]>().notNull(),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(1000),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("knowledge_tag_definitions_kind_slug_unique").on(table.kind, table.slug)],
);

export const sqliteKnowledgeCommunityLabels = sqliteTable("knowledge_community_labels", {
  communityKey: text("community_key").primaryKey(),
  label: text("label").notNull(),
  note: text("note"),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteKnowledgeQualityAdjustments = sqliteTable("knowledge_quality_adjustments", {
  id: text("id").primaryKey(),
  knowledgeId: text("knowledge_id")
    .notNull()
    .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
  adjustmentKind: text("adjustment_kind").notNull(),
  windowStartAt: text("window_start_at").notNull(),
  windowEndAt: text("window_end_at").notNull(),
  negativeRunCount: integer("negative_run_count").notNull(),
  offTopicRate: real("off_topic_rate").notNull(),
  importanceDelta: real("importance_delta").notNull(),
  confidenceDelta: real("confidence_delta").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sqliteKnowledgeOriginLinks = sqliteTable(
  "knowledge_origin_links",
  {
    id: text("id").primaryKey(),
    knowledgeId: text("knowledge_id")
      .notNull()
      .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
    originKind: text("origin_kind").notNull(),
    originUri: text("origin_uri").notNull(),
    originKey: text("origin_key").notNull(),
    confidence: real("confidence").notNull().default(1.0),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_origin_links_knowledge_kind_uri_unique").on(
      table.knowledgeId,
      table.originKind,
      table.originUri,
    ),
  ],
);

export const sqliteSources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastIndexedAt: text("last_indexed_at"),
  },
  (table) => [
    index("sources_kind_idx").on(table.sourceKind),
    uniqueIndex("sources_uri_unique_idx").on(table.uri),
  ],
);

export const sqliteSourceFragments = sqliteTable(
  "source_fragments",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sqliteSources.id, { onDelete: "cascade" }),
    locator: text("locator").notNull(),
    heading: text("heading"),
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("source_fragments_source_id_idx").on(table.sourceId),
    uniqueIndex("source_fragments_source_locator_unique").on(table.sourceId, table.locator),
  ],
);

export const sqliteKnowledgeSourceLinks = sqliteTable(
  "knowledge_source_links",
  {
    id: text("id").primaryKey(),
    knowledgeId: text("knowledge_id")
      .notNull()
      .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
    sourceFragmentId: text("source_fragment_id")
      .notNull()
      .references(() => sqliteSourceFragments.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull().default("derived_from"),
    confidence: real("confidence").notNull().default(0.5),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("knowledge_source_links_knowledge_idx").on(table.knowledgeId),
    index("knowledge_source_links_source_fragment_idx").on(table.sourceFragmentId),
  ],
);

export const sqliteCoreVectorMetadata = sqliteTable("core_vector_metadata", {
  name: text("name").primaryKey(),
  dimension: integer("dimension").notNull(),
  provider: text("provider"),
  model: text("model"),
  rebuiltAt: text("rebuilt_at"),
  rowCount: integer("row_count").notNull().default(0),
  usesSqliteVec: integer("uses_sqlite_vec", { mode: "boolean" }).notNull().default(false),
});

export const sqliteKnowledgeItemsVecMap = sqliteTable("knowledge_items_vec_map", {
  vecRowid: integer("vec_rowid").primaryKey({ autoIncrement: true }),
  knowledgeId: text("knowledge_id")
    .notNull()
    .unique()
    .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
});

export const sqliteKnowledgeItemsVecFallback = sqliteTable("knowledge_items_vec_fallback", {
  knowledgeId: text("knowledge_id")
    .primaryKey()
    .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
  embeddingJson: text("embedding_json").notNull(),
  embeddingDimension: integer("embedding_dimension").notNull(),
  contentHash: text("content_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteSourceFragmentsVecMap = sqliteTable("source_fragments_vec_map", {
  vecRowid: integer("vec_rowid").primaryKey({ autoIncrement: true }),
  sourceFragmentId: text("source_fragment_id")
    .notNull()
    .unique()
    .references(() => sqliteSourceFragments.id, { onDelete: "cascade" }),
});

export const sqliteSourceFragmentsVecFallback = sqliteTable("source_fragments_vec_fallback", {
  sourceFragmentId: text("source_fragment_id")
    .primaryKey()
    .references(() => sqliteSourceFragments.id, { onDelete: "cascade" }),
  embeddingJson: text("embedding_json").notNull(),
  embeddingDimension: integer("embedding_dimension").notNull(),
  contentHash: text("content_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
});
