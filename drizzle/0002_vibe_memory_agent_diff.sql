CREATE TABLE IF NOT EXISTS "vibe_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "content" text NOT NULL,
  "memory_type" text NOT NULL DEFAULT 'chat',
  "embedding" vector(384),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "agent_diff_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vibe_memory_id" uuid NOT NULL REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "file_path" text NOT NULL,
  "diff_hunk" text NOT NULL,
  "change_type" text,
  "language" text,
  "symbol_name" text,
  "symbol_kind" text,
  "signature" text,
  "start_line" integer,
  "end_line" integer,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "vibe_memories_session_id_idx" ON "vibe_memories" ("session_id");
CREATE INDEX IF NOT EXISTS "vibe_memories_memory_type_idx" ON "vibe_memories" ("memory_type");
CREATE INDEX IF NOT EXISTS "vibe_memories_content_fts_idx"
  ON "vibe_memories" USING gin (to_tsvector('simple', "content"));
CREATE INDEX IF NOT EXISTS "vibe_memories_embedding_hnsw_idx"
  ON "vibe_memories" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "agent_diff_entries_vibe_memory_id_idx"
  ON "agent_diff_entries" ("vibe_memory_id");
CREATE INDEX IF NOT EXISTS "agent_diff_entries_file_path_idx"
  ON "agent_diff_entries" ("file_path");
CREATE INDEX IF NOT EXISTS "agent_diff_entries_symbol_idx"
  ON "agent_diff_entries" ("symbol_name", "symbol_kind");
CREATE INDEX IF NOT EXISTS "agent_diff_entries_line_range_idx"
  ON "agent_diff_entries" ("start_line", "end_line");
