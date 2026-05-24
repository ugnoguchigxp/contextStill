CREATE TABLE IF NOT EXISTS "landscape_review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "proposed_action" text NOT NULL DEFAULT 'review_only',
  "priority" integer NOT NULL DEFAULT 50,
  "confidence" text NOT NULL DEFAULT 'low',
  "idempotency_key" text NOT NULL,
  "knowledge_id" uuid REFERENCES "knowledge_items"("id") ON DELETE cascade,
  "run_id" uuid REFERENCES "context_compile_runs"("id") ON DELETE set null,
  "trigger_event_id" uuid REFERENCES "knowledge_usage_events"("id") ON DELETE set null,
  "community_key" text,
  "community_label" text,
  "suggested_applies_to" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "note" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp,
  CONSTRAINT "landscape_review_items_source_check"
    CHECK ("source" IN (
      'replay_compare',
      'landscape_snapshot',
      'semantic_relation_comparison',
      'promotion_gate'
    )),
  CONSTRAINT "landscape_review_items_reason_check"
    CHECK ("reason" IN (
      'used_baseline_lost',
      'baseline_off_topic',
      'baseline_wrong',
      'baseline_missing_after_recompile',
      'negative_attractor_candidate',
      'wrong_review_required',
      'over_selected_not_used',
      'dead_zone_reachability_risk',
      'dead_zone_stale',
      'semantic_reachable_dead_zone',
      'semantic_split',
      'semantic_merge',
      'relation_orphan',
      'promotion_gate_review'
    )),
  CONSTRAINT "landscape_review_items_status_check"
    CHECK ("status" IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  CONSTRAINT "landscape_review_items_proposed_action_check"
    CHECK ("proposed_action" IN (
      'review_only',
      'refine_applies_to',
      'repair_reachability',
      'review_wrong',
      'split_or_merge_review',
      'promotion_gate_review',
      'demote_to_draft_candidate'
    )),
  CONSTRAINT "landscape_review_items_confidence_check"
    CHECK ("confidence" IN ('low', 'medium', 'high')),
  CONSTRAINT "landscape_review_items_priority_check"
    CHECK ("priority" >= 0 AND "priority" <= 100),
  CONSTRAINT "landscape_review_items_evidence_array_check"
    CHECK (jsonb_typeof("evidence") = 'array'),
  CONSTRAINT "landscape_review_items_suggested_applies_to_object_check"
    CHECK (jsonb_typeof("suggested_applies_to") = 'object'),
  CONSTRAINT "landscape_review_items_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "landscape_review_items_idempotency_key_unique"
  ON "landscape_review_items" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_items_status_priority_created_at_idx"
  ON "landscape_review_items" ("status", "priority" DESC, "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_items_knowledge_status_idx"
  ON "landscape_review_items" ("knowledge_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_items_community_status_idx"
  ON "landscape_review_items" ("community_key", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_items_run_status_idx"
  ON "landscape_review_items" ("run_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landscape_review_items_reason_status_idx"
  ON "landscape_review_items" ("reason", "status");
