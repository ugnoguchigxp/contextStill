ALTER TABLE IF EXISTS "vibe_memories"
  ADD COLUMN IF NOT EXISTS "dedupe_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "vibe_memories_session_dedupe_key_idx"
  ON "vibe_memories" ("session_id", "dedupe_key");

CREATE TABLE IF NOT EXISTS "sync_states" (
  "id" text PRIMARY KEY NOT NULL,
  "last_synced_at" timestamp NOT NULL DEFAULT now(),
  "cursor" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
