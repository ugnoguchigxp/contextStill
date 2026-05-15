CREATE TABLE IF NOT EXISTS "source_distillation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_fragment_id" uuid NOT NULL REFERENCES "source_fragments"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "candidate_count" integer NOT NULL DEFAULT 0,
  "knowledge_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error" text,
  "input_hash" text NOT NULL,
  "prompt_version" text NOT NULL,
  "model" text NOT NULL,
  "tool_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "source_distillation_runs_status_check"
    CHECK ("status" IN ('ok','skipped','failed'))
);

CREATE INDEX IF NOT EXISTS "source_distillation_runs_fragment_id_idx"
  ON "source_distillation_runs" ("source_fragment_id");
CREATE INDEX IF NOT EXISTS "source_distillation_runs_status_idx"
  ON "source_distillation_runs" ("status");
CREATE INDEX IF NOT EXISTS "source_distillation_runs_prompt_version_idx"
  ON "source_distillation_runs" ("prompt_version");
CREATE UNIQUE INDEX IF NOT EXISTS "source_distillation_runs_fragment_prompt_hash_idx"
  ON "source_distillation_runs" ("source_fragment_id", "prompt_version", "input_hash");

CREATE TABLE IF NOT EXISTS "source_distillation_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "source_distillation_runs"("id") ON DELETE CASCADE,
  "tool_name" text NOT NULL,
  "url" text,
  "ok" integer NOT NULL DEFAULT 0,
  "content_hash" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "source_distillation_evidence_run_id_idx"
  ON "source_distillation_evidence" ("run_id");
CREATE INDEX IF NOT EXISTS "source_distillation_evidence_tool_name_idx"
  ON "source_distillation_evidence" ("tool_name");
