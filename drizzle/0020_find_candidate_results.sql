CREATE TABLE IF NOT EXISTS "find_candidate_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_state_id" uuid NOT NULL REFERENCES "distillation_target_states"("id") ON DELETE CASCADE,
  "target_kind" text NOT NULL,
  "target_key" text NOT NULL,
  "source_uri" text NOT NULL,
  "input_hash" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "candidate_index" integer NOT NULL,
  "candidate_hash" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "origin" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "raw_output" text NOT NULL,
  "status" text NOT NULL DEFAULT 'selected',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "find_candidate_results_target_kind_check"
    CHECK ("target_kind" IN ('wiki_file','vibe_memory')),
  CONSTRAINT "find_candidate_results_status_check"
    CHECK ("status" IN ('selected','parse_failed'))
);

CREATE INDEX IF NOT EXISTS "find_candidate_results_target_state_idx"
  ON "find_candidate_results" ("target_state_id");

CREATE INDEX IF NOT EXISTS "find_candidate_results_target_input_idx"
  ON "find_candidate_results" ("target_state_id", "input_hash");

CREATE INDEX IF NOT EXISTS "find_candidate_results_status_idx"
  ON "find_candidate_results" ("status");

CREATE INDEX IF NOT EXISTS "find_candidate_results_candidate_hash_idx"
  ON "find_candidate_results" ("candidate_hash");

CREATE UNIQUE INDEX IF NOT EXISTS "find_candidate_results_dedupe_unique_idx"
  ON "find_candidate_results" ("target_state_id", "input_hash", "candidate_hash");
