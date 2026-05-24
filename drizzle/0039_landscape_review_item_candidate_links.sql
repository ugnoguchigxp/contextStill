CREATE TABLE IF NOT EXISTS "landscape_review_item_candidate_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_item_id" uuid NOT NULL REFERENCES "landscape_review_items"("id") ON DELETE cascade,
  "target_state_id" uuid NOT NULL REFERENCES "distillation_target_states"("id") ON DELETE cascade,
  "find_candidate_result_id" uuid NOT NULL REFERENCES "find_candidate_results"("id") ON DELETE cascade,
  "candidate_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft_created',
  "approval_note" text,
  "approved_by" text,
  "approved_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "landscape_review_item_candidate_links_status_check"
    CHECK ("status" IN (
      'draft_created',
      'review_required',
      'approved',
      'rejected',
      'finalized'
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "landscape_review_item_candidate_links_review_candidate_unique"
  ON "landscape_review_item_candidate_links" ("review_item_id", "candidate_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "landscape_review_item_candidate_links_target_candidate_unique"
  ON "landscape_review_item_candidate_links" ("target_state_id", "find_candidate_result_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_item_candidate_links_review_status_created_at_idx"
  ON "landscape_review_item_candidate_links" ("review_item_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_item_candidate_links_target_state_idx"
  ON "landscape_review_item_candidate_links" ("target_state_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_item_candidate_links_find_candidate_idx"
  ON "landscape_review_item_candidate_links" ("find_candidate_result_id");
