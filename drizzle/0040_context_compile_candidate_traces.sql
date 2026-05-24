CREATE TABLE IF NOT EXISTS "context_compile_candidate_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "context_compile_runs"("id") ON DELETE cascade,
  "item_kind" text NOT NULL,
  "item_id" uuid NOT NULL REFERENCES "knowledge_items"("id") ON DELETE cascade,
  "text_rank" integer,
  "text_score" real,
  "vector_rank" integer,
  "vector_score" real,
  "merged_rank" integer,
  "merged_score" real,
  "final_rank" integer,
  "final_score" real,
  "selected" boolean NOT NULL DEFAULT false,
  "suppressed" boolean NOT NULL DEFAULT false,
  "suppression_reason" text,
  "agentic_decision" text NOT NULL DEFAULT 'not_evaluated',
  "ranking_reason" text,
  "community_key" text,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "context_compile_candidate_traces_item_kind_check"
    CHECK ("item_kind" IN ('rule', 'procedure')),
  CONSTRAINT "context_compile_candidate_traces_agentic_decision_check"
    CHECK ("agentic_decision" IN ('not_evaluated', 'accepted', 'rejected', 'skipped')),
  CONSTRAINT "context_compile_candidate_traces_evidence_object_check"
    CHECK (jsonb_typeof("evidence") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_compile_candidate_traces_run_item_unique"
  ON "context_compile_candidate_traces" ("run_id", "item_kind", "item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_candidate_traces_run_final_rank_idx"
  ON "context_compile_candidate_traces" ("run_id", "final_rank");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_candidate_traces_item_created_at_idx"
  ON "context_compile_candidate_traces" ("item_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_candidate_traces_run_selected_idx"
  ON "context_compile_candidate_traces" ("run_id", "selected");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_candidate_traces_suppression_reason_idx"
  ON "context_compile_candidate_traces" ("suppression_reason");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_candidate_traces_community_key_created_at_idx"
  ON "context_compile_candidate_traces" ("community_key", "created_at");
