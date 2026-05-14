CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "knowledge_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'repo',
  "title" text NOT NULL,
  "body" text NOT NULL,
  "applies_to" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "confidence" real NOT NULL DEFAULT 0.5,
  "importance" real NOT NULL DEFAULT 0.5,
  "embedding" vector(384),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_verified_at" timestamp,
  CONSTRAINT "knowledge_items_type_check" CHECK ("type" IN ('fact','rule','procedure','lesson')),
  CONSTRAINT "knowledge_items_status_check" CHECK ("status" IN ('draft','active','deprecated')),
  CONSTRAINT "knowledge_items_scope_check" CHECK ("scope" IN ('repo','global'))
);

CREATE TABLE IF NOT EXISTS "relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" text NOT NULL,
  "relation_type" text NOT NULL,
  "confidence" real NOT NULL DEFAULT 0.5,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "relations_relation_type_check" CHECK ("relation_type" IN ('supports','derived_from','contradicts','supersedes','applies_to','mentions','impacts'))
);

CREATE TABLE IF NOT EXISTS "context_compile_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "goal" text NOT NULL,
  "intent" text NOT NULL,
  "repo_path" text,
  "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "retrieval_mode" text NOT NULL,
  "status" text NOT NULL,
  "degraded_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "token_budget" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "context_compile_runs_status_check" CHECK ("status" IN ('ok','degraded','failed'))
);

CREATE TABLE IF NOT EXISTS "context_pack_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "context_compile_runs"("id") ON DELETE CASCADE,
  "item_kind" text NOT NULL,
  "item_id" text NOT NULL,
  "section" text NOT NULL,
  "score" real NOT NULL DEFAULT 0,
  "ranking_reason" text NOT NULL,
  "source_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "context_pack_items_section_check" CHECK ("section" IN ('rules','procedures','lessons','code_context','warnings'))
);

CREATE INDEX IF NOT EXISTS "knowledge_items_type_idx" ON "knowledge_items" ("type");
CREATE INDEX IF NOT EXISTS "knowledge_items_status_idx" ON "knowledge_items" ("status");
CREATE INDEX IF NOT EXISTS "knowledge_items_scope_idx" ON "knowledge_items" ("scope");
CREATE INDEX IF NOT EXISTS "knowledge_items_type_status_idx" ON "knowledge_items" ("type", "status");
CREATE INDEX IF NOT EXISTS "knowledge_items_title_body_fts_idx"
  ON "knowledge_items" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", '')));
CREATE INDEX IF NOT EXISTS "knowledge_items_embedding_hnsw_idx"
  ON "knowledge_items" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "relations_source_idx" ON "relations" ("source_kind", "source_id");
CREATE INDEX IF NOT EXISTS "relations_target_idx" ON "relations" ("target_kind", "target_id");
CREATE INDEX IF NOT EXISTS "relations_relation_type_idx" ON "relations" ("relation_type");

CREATE INDEX IF NOT EXISTS "context_compile_runs_status_idx" ON "context_compile_runs" ("status");
CREATE INDEX IF NOT EXISTS "context_compile_runs_created_at_idx" ON "context_compile_runs" ("created_at");

CREATE INDEX IF NOT EXISTS "context_pack_items_run_id_idx" ON "context_pack_items" ("run_id");
CREATE INDEX IF NOT EXISTS "context_pack_items_section_idx" ON "context_pack_items" ("section");
