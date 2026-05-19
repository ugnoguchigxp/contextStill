CREATE TABLE IF NOT EXISTS "distillation_target_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_kind" text NOT NULL,
  "target_key" text NOT NULL,
  "source_uri" text NOT NULL,
  "input_hash" text NOT NULL,
  "distillation_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "phase" text NOT NULL DEFAULT 'selected',
  "priority_group" text NOT NULL,
  "sort_key" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "locked_by" text,
  "locked_at" timestamp,
  "heartbeat_at" timestamp,
  "next_retry_at" timestamp,
  "last_error" text,
  "last_outcome_kind" text,
  "candidate_count" integer NOT NULL DEFAULT 0,
  "knowledge_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  CONSTRAINT "distillation_target_states_target_kind_check"
    CHECK ("target_kind" IN ('wiki_file','vibe_memory')),
  CONSTRAINT "distillation_target_states_status_check"
    CHECK ("status" IN ('pending','running','completed','skipped','failed','paused')),
  CONSTRAINT "distillation_target_states_phase_check"
    CHECK ("phase" IN ('selected','reading','finding_candidate','covering_evidence','finalizing','stored')),
  CONSTRAINT "distillation_target_states_priority_group_check"
    CHECK ("priority_group" IN ('wiki','vibe_memory'))
);

CREATE INDEX IF NOT EXISTS "distillation_target_states_status_idx"
  ON "distillation_target_states" ("status");

CREATE INDEX IF NOT EXISTS "distillation_target_states_kind_status_idx"
  ON "distillation_target_states" ("target_kind", "status");

CREATE INDEX IF NOT EXISTS "distillation_target_states_priority_select_idx"
  ON "distillation_target_states" ("priority_group", "status", "sort_key");

CREATE INDEX IF NOT EXISTS "distillation_target_states_heartbeat_idx"
  ON "distillation_target_states" ("heartbeat_at");

CREATE INDEX IF NOT EXISTS "distillation_target_states_next_retry_at_idx"
  ON "distillation_target_states" ("next_retry_at");

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_target_states_target_unique_idx"
  ON "distillation_target_states" (
    "target_kind",
    "target_key",
    "input_hash",
    "distillation_version"
  );
