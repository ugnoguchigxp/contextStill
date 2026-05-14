ALTER TABLE IF EXISTS "evidence_sources"
  DROP CONSTRAINT IF EXISTS "evidence_sources_source_kind_check";

ALTER TABLE IF EXISTS "evidence_sources"
  ADD CONSTRAINT "evidence_sources_source_kind_check"
  CHECK ("source_kind" IN (
    'markdown',
    'session',
    'tool_output',
    'git',
    'web',
    'manual',
    'vibe_memory',
    'ai_artifact'
  ));

ALTER TABLE IF EXISTS "sources"
  DROP CONSTRAINT IF EXISTS "sources_source_kind_check";

ALTER TABLE IF EXISTS "sources"
  ADD CONSTRAINT "sources_source_kind_check"
  CHECK ("source_kind" IN (
    'markdown',
    'session',
    'tool_output',
    'git',
    'web',
    'manual',
    'vibe_memory',
    'ai_artifact'
  ));

DROP TABLE IF EXISTS "code_symbols";

CREATE TABLE IF NOT EXISTS "vibe_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "content" text NOT NULL,
  "memory_type" text NOT NULL DEFAULT 'chat',
  "embedding" vector(384),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ai_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vibe_memory_id" uuid NOT NULL REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "file_path" text NOT NULL,
  "content" text NOT NULL,
  "diff" text,
  "language" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "artifact_symbols" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "ai_artifacts"("id") ON DELETE CASCADE,
  "symbol_name" text NOT NULL,
  "symbol_kind" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "signature" text,
  "start_line" integer,
  "end_line" integer,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "knowledge_activity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "knowledge_id" uuid NOT NULL REFERENCES "knowledge_items"("id") ON DELETE CASCADE,
  "vibe_memory_id" uuid REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "ai_artifact_id" uuid REFERENCES "ai_artifacts"("id") ON DELETE CASCADE,
  "link_type" text NOT NULL DEFAULT 'derived_from',
  "confidence" real NOT NULL DEFAULT 0.5,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_activity_links_link_type_check" CHECK ("link_type" IN ('derived_from','implemented_in')),
  CONSTRAINT "knowledge_activity_links_target_check" CHECK ("vibe_memory_id" IS NOT NULL OR "ai_artifact_id" IS NOT NULL)
);

ALTER TABLE IF EXISTS "ai_artifacts"
  ADD COLUMN IF NOT EXISTS "vibe_memory_id" uuid,
  ADD COLUMN IF NOT EXISTS "file_path" text,
  ADD COLUMN IF NOT EXISTS "content" text,
  ADD COLUMN IF NOT EXISTS "diff" text,
  ADD COLUMN IF NOT EXISTS "language" text,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT now();

ALTER TABLE IF EXISTS "artifact_symbols"
  ADD COLUMN IF NOT EXISTS "content" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "start_line" integer,
  ADD COLUMN IF NOT EXISTS "end_line" integer,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now();

DO $$
DECLARE
  orphan_memory_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ai_artifacts'
  ) AND EXISTS (
    SELECT 1 FROM "ai_artifacts" WHERE "vibe_memory_id" IS NULL
  ) THEN
    INSERT INTO "vibe_memories" ("session_id", "content", "memory_type", "metadata")
    VALUES (
      'migration:orphan-artifacts',
      'Migration placeholder for artifacts that predated the required vibe memory relation.',
      'system',
      '{"migration":"0002_activity_artifacts"}'::jsonb
    )
    RETURNING "id" INTO orphan_memory_id;

    UPDATE "ai_artifacts"
    SET "vibe_memory_id" = orphan_memory_id
    WHERE "vibe_memory_id" IS NULL;
  END IF;
END $$;

UPDATE "ai_artifacts"
SET
  "file_path" = COALESCE("file_path", ''),
  "content" = COALESCE("content", '')
WHERE "file_path" IS NULL OR "content" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ai_artifacts'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'ai_artifacts'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (vibe_memory_id)%REFERENCES vibe_memories%'
  ) THEN
    ALTER TABLE "ai_artifacts"
      ADD CONSTRAINT "ai_artifacts_vibe_memory_id_fkey"
      FOREIGN KEY ("vibe_memory_id") REFERENCES "vibe_memories"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_artifacts'
      AND column_name = 'vibe_memory_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM "ai_artifacts" WHERE "vibe_memory_id" IS NULL
  ) THEN
    ALTER TABLE "ai_artifacts" ALTER COLUMN "vibe_memory_id" SET NOT NULL;
  END IF;
END $$;

ALTER TABLE IF EXISTS "ai_artifacts"
  ALTER COLUMN "file_path" SET NOT NULL,
  ALTER COLUMN "content" SET NOT NULL;

DELETE FROM "knowledge_activity_links"
WHERE "vibe_memory_id" IS NULL AND "ai_artifact_id" IS NULL;

ALTER TABLE IF EXISTS "knowledge_activity_links"
  DROP CONSTRAINT IF EXISTS "knowledge_activity_links_target_check";

ALTER TABLE IF EXISTS "knowledge_activity_links"
  ADD CONSTRAINT "knowledge_activity_links_target_check"
  CHECK ("vibe_memory_id" IS NOT NULL OR "ai_artifact_id" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "vibe_memories_session_id_idx" ON "vibe_memories" ("session_id");
CREATE INDEX IF NOT EXISTS "vibe_memories_memory_type_idx" ON "vibe_memories" ("memory_type");
CREATE INDEX IF NOT EXISTS "vibe_memories_content_fts_idx" ON "vibe_memories" USING gin (to_tsvector('simple', "content"));
CREATE INDEX IF NOT EXISTS "vibe_memories_embedding_hnsw_idx" ON "vibe_memories" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "ai_artifacts_vibe_memory_id_idx" ON "ai_artifacts" ("vibe_memory_id");
CREATE INDEX IF NOT EXISTS "ai_artifacts_file_path_idx" ON "ai_artifacts" ("file_path");

CREATE INDEX IF NOT EXISTS "artifact_symbols_artifact_id_idx" ON "artifact_symbols" ("artifact_id");
CREATE INDEX IF NOT EXISTS "artifact_symbols_name_kind_idx" ON "artifact_symbols" ("symbol_name", "symbol_kind");
CREATE INDEX IF NOT EXISTS "artifact_symbols_line_range_idx" ON "artifact_symbols" ("start_line", "end_line");

CREATE INDEX IF NOT EXISTS "knowledge_activity_links_knowledge_idx" ON "knowledge_activity_links" ("knowledge_id");
CREATE INDEX IF NOT EXISTS "knowledge_activity_links_vibe_memory_idx" ON "knowledge_activity_links" ("vibe_memory_id");
CREATE INDEX IF NOT EXISTS "knowledge_activity_links_ai_artifact_idx" ON "knowledge_activity_links" ("ai_artifact_id");
