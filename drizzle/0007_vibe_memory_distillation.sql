CREATE TABLE IF NOT EXISTS "vibe_memory_distillation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vibe_memory_id" uuid NOT NULL REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "candidate_count" integer NOT NULL DEFAULT 0,
  "knowledge_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error" text,
  "input_hash" text NOT NULL,
  "prompt_version" text NOT NULL,
  "model" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "vibe_memory_distillation_runs_status_check"
    CHECK ("status" IN ('ok','skipped','failed'))
);

CREATE INDEX IF NOT EXISTS "vibe_memory_distillation_runs_memory_id_idx"
  ON "vibe_memory_distillation_runs" ("vibe_memory_id");
CREATE INDEX IF NOT EXISTS "vibe_memory_distillation_runs_status_idx"
  ON "vibe_memory_distillation_runs" ("status");
CREATE INDEX IF NOT EXISTS "vibe_memory_distillation_runs_prompt_version_idx"
  ON "vibe_memory_distillation_runs" ("prompt_version");
CREATE UNIQUE INDEX IF NOT EXISTS "vibe_memory_distillation_runs_memory_prompt_hash_idx"
  ON "vibe_memory_distillation_runs" ("vibe_memory_id", "prompt_version", "input_hash");
