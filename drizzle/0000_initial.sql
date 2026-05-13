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
  CONSTRAINT "knowledge_items_type_check" CHECK ("type" IN ('fact','decision','rule','procedure','skill','risk','lesson','example')),
  CONSTRAINT "knowledge_items_status_check" CHECK ("status" IN ('candidate','draft','trial','active','deprecated','rejected')),
  CONSTRAINT "knowledge_items_scope_check" CHECK ("scope" IN ('user','repo','workspace','org','global'))
);

CREATE TABLE IF NOT EXISTS "evidence_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text NOT NULL,
  "uri" text NOT NULL,
  "title" text,
  "content_hash" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "evidence_sources_source_kind_check" CHECK ("source_kind" IN ('markdown','session','tool_output','git','web','manual'))
);

CREATE TABLE IF NOT EXISTS "evidence_fragments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "evidence_sources"("id") ON DELETE CASCADE,
  "locator" text NOT NULL,
  "content" text NOT NULL,
  "embedding" vector(384),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
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
  "evidence_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "context_pack_items_section_check" CHECK ("section" IN ('rules','skills','examples','code_context','warnings','evidence'))
);

CREATE TABLE IF NOT EXISTS "code_symbols" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_path" text NOT NULL,
  "file_path" text NOT NULL,
  "symbol_name" text NOT NULL,
  "symbol_kind" text NOT NULL,
  "signature" text,
  "start_line" integer,
  "end_line" integer,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "embedding" vector(384),
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
