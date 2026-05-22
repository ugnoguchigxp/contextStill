CREATE TABLE IF NOT EXISTS "knowledge_usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "context_compile_runs"("id") ON DELETE cascade,
  "knowledge_id" uuid NOT NULL REFERENCES "knowledge_items"("id") ON DELETE cascade,
  "verdict" text NOT NULL,
  "actor" text NOT NULL,
  "reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_usage_events_verdict_check"
    CHECK ("verdict" IN ('used', 'off_topic', 'wrong')),
  CONSTRAINT "knowledge_usage_events_actor_check"
    CHECK ("actor" IN ('agent', 'user', 'system')),
  CONSTRAINT "knowledge_usage_events_reason_length_check"
    CHECK ("reason" IS NULL OR char_length("reason") <= 160)
);

CREATE INDEX IF NOT EXISTS "knowledge_usage_events_run_id_idx"
  ON "knowledge_usage_events" ("run_id");

CREATE INDEX IF NOT EXISTS "knowledge_usage_events_knowledge_id_idx"
  ON "knowledge_usage_events" ("knowledge_id");

CREATE INDEX IF NOT EXISTS "knowledge_usage_events_verdict_created_at_idx"
  ON "knowledge_usage_events" ("verdict", "created_at");

CREATE INDEX IF NOT EXISTS "knowledge_usage_events_knowledge_verdict_created_at_idx"
  ON "knowledge_usage_events" ("knowledge_id", "verdict", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_usage_events_run_knowledge_unique"
  ON "knowledge_usage_events" ("run_id", "knowledge_id");

CREATE TABLE IF NOT EXISTS "knowledge_review_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "knowledge_id" uuid NOT NULL REFERENCES "knowledge_items"("id") ON DELETE cascade,
  "trigger_event_id" uuid NOT NULL REFERENCES "knowledge_usage_events"("id") ON DELETE cascade,
  "trigger_verdict" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "proposed_action" text NOT NULL DEFAULT 'review_only',
  "note" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_review_queue_trigger_verdict_check"
    CHECK ("trigger_verdict" IN ('used', 'off_topic', 'wrong')),
  CONSTRAINT "knowledge_review_queue_status_check"
    CHECK ("status" IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  CONSTRAINT "knowledge_review_queue_proposed_action_check"
    CHECK ("proposed_action" IN ('review_only', 'demote_to_draft_candidate'))
);

CREATE INDEX IF NOT EXISTS "knowledge_review_queue_status_created_at_idx"
  ON "knowledge_review_queue" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "knowledge_review_queue_knowledge_status_idx"
  ON "knowledge_review_queue" ("knowledge_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_review_queue_trigger_event_unique"
  ON "knowledge_review_queue" ("trigger_event_id");

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_review_queue_active_knowledge_unique"
  ON "knowledge_review_queue" ("knowledge_id")
  WHERE "status" IN ('pending', 'reviewing');

CREATE TABLE IF NOT EXISTS "knowledge_quality_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "knowledge_id" uuid NOT NULL REFERENCES "knowledge_items"("id") ON DELETE cascade,
  "adjustment_kind" text NOT NULL,
  "window_start_at" timestamp NOT NULL,
  "window_end_at" timestamp NOT NULL,
  "negative_run_count" integer NOT NULL,
  "off_topic_rate" real NOT NULL,
  "importance_delta" real NOT NULL,
  "confidence_delta" real NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_quality_adjustments_adjustment_kind_check"
    CHECK ("adjustment_kind" IN ('off_topic_quality_decrement'))
);

CREATE INDEX IF NOT EXISTS "knowledge_quality_adjustments_knowledge_kind_created_at_idx"
  ON "knowledge_quality_adjustments" ("knowledge_id", "adjustment_kind", "created_at");

CREATE INDEX IF NOT EXISTS "knowledge_quality_adjustments_created_at_idx"
  ON "knowledge_quality_adjustments" ("created_at");
