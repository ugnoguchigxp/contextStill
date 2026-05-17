CREATE TABLE IF NOT EXISTS "distillation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text NOT NULL,
  "vibe_memory_id" uuid REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "source_fragment_id" uuid REFERENCES "source_fragments"("id") ON DELETE CASCADE,
  "input_hash" text NOT NULL,
  "prompt_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "phase" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "budget" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "budget_used" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error" text,
  "last_outcome_kind" text,
  "next_retry_at" timestamp,
  "locked_by" text,
  "locked_at" timestamp,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "distillation_jobs_source_kind_check" CHECK ("source_kind" IN ('vibe_memory','source_fragment')),
  CONSTRAINT "distillation_jobs_status_check" CHECK ("status" IN ('queued','running','paused','completed','skipped','failed')),
  CONSTRAINT "distillation_jobs_phase_check" CHECK ("phase" IN ('pending','reading','extracting','verifying','promoting','completed')),
  CONSTRAINT "distillation_jobs_source_ref_check" CHECK (
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

CREATE INDEX IF NOT EXISTS "distillation_jobs_status_idx"
  ON "distillation_jobs" ("status");

CREATE INDEX IF NOT EXISTS "distillation_jobs_phase_idx"
  ON "distillation_jobs" ("phase");

CREATE INDEX IF NOT EXISTS "distillation_jobs_source_kind_idx"
  ON "distillation_jobs" ("source_kind");

CREATE INDEX IF NOT EXISTS "distillation_jobs_vibe_memory_id_idx"
  ON "distillation_jobs" ("vibe_memory_id");

CREATE INDEX IF NOT EXISTS "distillation_jobs_source_fragment_id_idx"
  ON "distillation_jobs" ("source_fragment_id");

CREATE INDEX IF NOT EXISTS "distillation_jobs_next_retry_at_idx"
  ON "distillation_jobs" ("next_retry_at");

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_jobs_vibe_unique_idx"
  ON "distillation_jobs" ("vibe_memory_id", "prompt_version", "input_hash")
  WHERE "vibe_memory_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_jobs_source_unique_idx"
  ON "distillation_jobs" ("source_fragment_id", "prompt_version", "input_hash")
  WHERE "source_fragment_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "distillation_evidence_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name" text NOT NULL,
  "query_hash" text NOT NULL,
  "query_text" text,
  "url" text,
  "content_hash" text,
  "ok" integer NOT NULL DEFAULT 0,
  "excerpt" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "fetched_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "distillation_evidence_cache_tool_name_idx"
  ON "distillation_evidence_cache" ("tool_name");

CREATE INDEX IF NOT EXISTS "distillation_evidence_cache_query_hash_idx"
  ON "distillation_evidence_cache" ("query_hash");

CREATE INDEX IF NOT EXISTS "distillation_evidence_cache_url_idx"
  ON "distillation_evidence_cache" ("url");

CREATE INDEX IF NOT EXISTS "distillation_evidence_cache_fetched_at_idx"
  ON "distillation_evidence_cache" ("fetched_at");

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_evidence_cache_lookup_idx"
  ON "distillation_evidence_cache" ("tool_name", "query_hash", "url");

CREATE TABLE IF NOT EXISTS "distillation_read_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid REFERENCES "distillation_jobs"("id") ON DELETE CASCADE,
  "candidate_id" uuid REFERENCES "distillation_candidates"("id") ON DELETE SET NULL,
  "source_kind" text NOT NULL,
  "vibe_memory_id" uuid REFERENCES "vibe_memories"("id") ON DELETE CASCADE,
  "source_fragment_id" uuid REFERENCES "source_fragments"("id") ON DELETE CASCADE,
  "locator" text NOT NULL,
  "purpose" text,
  "content_hash" text NOT NULL,
  "char_count" integer NOT NULL DEFAULT 0,
  "truncated" integer NOT NULL DEFAULT 0,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "distillation_read_events_source_kind_check" CHECK ("source_kind" IN ('vibe_memory','source_fragment')),
  CONSTRAINT "distillation_read_events_source_ref_check" CHECK (
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

CREATE INDEX IF NOT EXISTS "distillation_read_events_job_id_idx"
  ON "distillation_read_events" ("job_id");

CREATE INDEX IF NOT EXISTS "distillation_read_events_candidate_id_idx"
  ON "distillation_read_events" ("candidate_id");

CREATE INDEX IF NOT EXISTS "distillation_read_events_source_kind_idx"
  ON "distillation_read_events" ("source_kind");

CREATE INDEX IF NOT EXISTS "distillation_read_events_vibe_memory_id_idx"
  ON "distillation_read_events" ("vibe_memory_id");

CREATE INDEX IF NOT EXISTS "distillation_read_events_source_fragment_id_idx"
  ON "distillation_read_events" ("source_fragment_id");

CREATE INDEX IF NOT EXISTS "distillation_read_events_content_hash_idx"
  ON "distillation_read_events" ("content_hash");
