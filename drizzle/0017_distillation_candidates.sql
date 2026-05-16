CREATE TABLE IF NOT EXISTS "distillation_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text NOT NULL,
  "vibe_memory_id" uuid REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "source_fragment_id" uuid REFERENCES "source_fragments"("id") ON DELETE CASCADE,
  "vibe_memory_run_id" uuid REFERENCES "vibe_memory_distillation_runs"("id") ON DELETE SET NULL,
  "source_run_id" uuid REFERENCES "source_distillation_runs"("id") ON DELETE SET NULL,
  "input_hash" text NOT NULL,
  "prompt_version" text NOT NULL,
  "model" text NOT NULL,
  "candidate_index" integer NOT NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "score" real NOT NULL DEFAULT 0,
  "confidence" real,
  "importance" real,
  "status" text NOT NULL DEFAULT 'extracted',
  "rejection_reason" text,
  "knowledge_id" uuid REFERENCES "knowledge_items"("id") ON DELETE SET NULL,
  "tool_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evaluated_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "distillation_candidates_source_kind_check" CHECK ("source_kind" IN ('vibe_memory','source_fragment')),
  CONSTRAINT "distillation_candidates_status_check" CHECK ("status" IN ('extracted','evaluating','verified','promoted','rejected','failed')),
  CONSTRAINT "distillation_candidates_type_check" CHECK ("type" IN ('rule','procedure')),
  CONSTRAINT "distillation_candidates_source_ref_check" CHECK (
    (
      "source_kind" = 'vibe_memory'
      AND "vibe_memory_id" IS NOT NULL
      AND "source_fragment_id" IS NULL
    )
    OR
    (
      "source_kind" = 'source_fragment'
      AND "source_fragment_id" IS NOT NULL
      AND "vibe_memory_id" IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS "distillation_candidates_status_idx"
  ON "distillation_candidates" ("status");

CREATE INDEX IF NOT EXISTS "distillation_candidates_source_kind_idx"
  ON "distillation_candidates" ("source_kind");

CREATE INDEX IF NOT EXISTS "distillation_candidates_vibe_memory_id_idx"
  ON "distillation_candidates" ("vibe_memory_id");

CREATE INDEX IF NOT EXISTS "distillation_candidates_source_fragment_id_idx"
  ON "distillation_candidates" ("source_fragment_id");

CREATE INDEX IF NOT EXISTS "distillation_candidates_knowledge_id_idx"
  ON "distillation_candidates" ("knowledge_id");

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_candidates_vibe_candidate_unique_idx"
  ON "distillation_candidates" ("vibe_memory_id", "prompt_version", "input_hash", "candidate_index")
  WHERE "vibe_memory_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_candidates_source_candidate_unique_idx"
  ON "distillation_candidates" ("source_fragment_id", "prompt_version", "input_hash", "candidate_index")
  WHERE "source_fragment_id" IS NOT NULL;
