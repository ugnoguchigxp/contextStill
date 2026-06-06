CREATE TABLE IF NOT EXISTS "dead_zone_merge_review_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_item_id" uuid,
  "dead_zone_knowledge_id" uuid NOT NULL,
  "canonical_knowledge_id" uuid,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" integer DEFAULT 50 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 2 NOT NULL,
  "next_run_at" timestamp,
  "locked_by" text,
  "locked_at" timestamp,
  "heartbeat_at" timestamp,
  "last_error" text,
  "last_outcome_kind" text,
  "provider" text DEFAULT 'local-llm' NOT NULL,
  "model" text,
  "input_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "dead_zone_merge_review_queue_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
  CONSTRAINT "dead_zone_merge_review_queue_distinct_knowledge_check"
    CHECK ("canonical_knowledge_id" IS NULL OR "dead_zone_knowledge_id" <> "canonical_knowledge_id"),
  CONSTRAINT "dead_zone_merge_review_queue_input_snapshot_object_check"
    CHECK (jsonb_typeof("input_snapshot") = 'object'),
  CONSTRAINT "dead_zone_merge_review_queue_result_object_check"
    CHECK (jsonb_typeof("result") = 'object'),
  CONSTRAINT "dead_zone_merge_review_queue_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "dead_zone_merge_review_queue_metadata_object_check"
    CHECK (jsonb_typeof("metadata") = 'object')
);

ALTER TABLE "dead_zone_merge_review_queue"
  ADD CONSTRAINT "dead_zone_merge_review_queue_review_item_id_landscape_review_items_id_fk"
  FOREIGN KEY ("review_item_id") REFERENCES "public"."landscape_review_items"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "dead_zone_merge_review_queue"
  ADD CONSTRAINT "dead_zone_merge_review_queue_dead_zone_knowledge_id_knowledge_items_id_fk"
  FOREIGN KEY ("dead_zone_knowledge_id") REFERENCES "public"."knowledge_items"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "dead_zone_merge_review_queue"
  ADD CONSTRAINT "dead_zone_merge_review_queue_canonical_knowledge_id_knowledge_items_id_fk"
  FOREIGN KEY ("canonical_knowledge_id") REFERENCES "public"."knowledge_items"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE UNIQUE INDEX IF NOT EXISTS "dead_zone_merge_review_queue_idempotency_unique"
  ON "dead_zone_merge_review_queue" USING btree ("idempotency_key");

CREATE INDEX IF NOT EXISTS "dead_zone_merge_review_queue_status_priority_created_at_idx"
  ON "dead_zone_merge_review_queue" USING btree ("status", "priority", "created_at");

CREATE INDEX IF NOT EXISTS "dead_zone_merge_review_queue_dead_zone_status_idx"
  ON "dead_zone_merge_review_queue" USING btree ("dead_zone_knowledge_id", "status");

CREATE INDEX IF NOT EXISTS "dead_zone_merge_review_queue_canonical_status_idx"
  ON "dead_zone_merge_review_queue" USING btree ("canonical_knowledge_id", "status");

CREATE INDEX IF NOT EXISTS "dead_zone_merge_review_queue_review_item_status_idx"
  ON "dead_zone_merge_review_queue" USING btree ("review_item_id", "status");

ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_queue_name_check";

ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_queue_name_check"
  CHECK ("queue_name" IN (
    'findingCandidate',
    'coveringEvidence',
    'deadZoneMergeReview',
    'finalizeDistille'
  ));
