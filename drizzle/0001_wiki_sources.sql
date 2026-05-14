CREATE TABLE IF NOT EXISTS "sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text NOT NULL,
  "uri" text NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "content_hash" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_indexed_at" timestamp,
  CONSTRAINT "sources_source_kind_check" CHECK ("source_kind" IN ('wiki'))
);

CREATE TABLE IF NOT EXISTS "source_fragments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
  "locator" text NOT NULL,
  "heading" text,
  "content" text NOT NULL,
  "embedding" vector(384),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "knowledge_source_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "knowledge_id" uuid NOT NULL REFERENCES "knowledge_items"("id") ON DELETE CASCADE,
  "source_fragment_id" uuid NOT NULL REFERENCES "source_fragments"("id") ON DELETE CASCADE,
  "link_type" text NOT NULL DEFAULT 'derived_from',
  "confidence" real NOT NULL DEFAULT 0.5,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_links_link_type_check" CHECK ("link_type" IN ('derived_from'))
);

CREATE INDEX IF NOT EXISTS "sources_kind_idx" ON "sources" ("source_kind");
CREATE INDEX IF NOT EXISTS "sources_uri_idx" ON "sources" ("uri");
CREATE INDEX IF NOT EXISTS "sources_uri_hash_idx" ON "sources" ("uri", "content_hash");
CREATE INDEX IF NOT EXISTS "sources_body_fts_idx"
  ON "sources" USING gin (to_tsvector('simple', "body"));

CREATE INDEX IF NOT EXISTS "source_fragments_source_id_idx" ON "source_fragments" ("source_id");
CREATE INDEX IF NOT EXISTS "source_fragments_source_locator_idx"
  ON "source_fragments" ("source_id", "locator");
CREATE INDEX IF NOT EXISTS "source_fragments_content_fts_idx"
  ON "source_fragments" USING gin (to_tsvector('simple', "content"));
CREATE INDEX IF NOT EXISTS "source_fragments_embedding_hnsw_idx"
  ON "source_fragments" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "knowledge_source_links_knowledge_idx"
  ON "knowledge_source_links" ("knowledge_id");
CREATE INDEX IF NOT EXISTS "knowledge_source_links_source_fragment_idx"
  ON "knowledge_source_links" ("source_fragment_id");
CREATE INDEX IF NOT EXISTS "knowledge_source_links_link_type_idx"
  ON "knowledge_source_links" ("link_type");
