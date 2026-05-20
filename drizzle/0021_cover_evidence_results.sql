CREATE TABLE IF NOT EXISTS "cover_evidence_results" (
  "id" uuid PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "stage" text NOT NULL,
  "type" text,
  "title" text,
  "body" text,
  "importance" real,
  "confidence" real,
  "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "duplicate_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tried_stages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tool_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reason" text,
  "raw_output" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "cover_evidence_results_status_check"
    CHECK ("status" IN ('knowledge_ready','duplicate','near_duplicate','insufficient','parse_failed','tool_failed','provider_failed')),
  CONSTRAINT "cover_evidence_results_stage_check"
    CHECK ("stage" IN ('load','source_support','dedupe','evidence_need','web','mcp','final')),
  CONSTRAINT "cover_evidence_results_type_check"
    CHECK ("type" IS NULL OR "type" IN ('rule','procedure')),
  CONSTRAINT "cover_evidence_results_reason_length_check"
    CHECK ("reason" IS NULL OR char_length("reason") <= 160),
  CONSTRAINT "cover_evidence_results_id_find_candidate_results_id_fk"
    FOREIGN KEY ("id") REFERENCES "find_candidate_results"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "cover_evidence_results_status_idx"
  ON "cover_evidence_results" ("status");

CREATE INDEX IF NOT EXISTS "cover_evidence_results_stage_idx"
  ON "cover_evidence_results" ("stage");
