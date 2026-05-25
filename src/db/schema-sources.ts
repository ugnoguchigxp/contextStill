import { sql } from "drizzle-orm";
import {
  check,
  index,
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
import { sourceKindValues, sourceLinkTypeValues } from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

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
