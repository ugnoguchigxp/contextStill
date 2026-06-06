CREATE TABLE "merge_activation_finalize_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merge_review_job_id" uuid NOT NULL,
  "dead_zone_knowledge_id" uuid NOT NULL,
  "canonical_knowledge_id" uuid NOT NULL,
  "review_item_id" uuid,
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
  "activation_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "knowledge_id" uuid,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "merge_activation_finalize_queue_idempotency_unique" UNIQUE("idempotency_key"),
  CONSTRAINT "merge_activation_finalize_queue_status_check" CHECK ("merge_activation_finalize_queue"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
  CONSTRAINT "merge_activation_finalize_queue_distinct_knowledge_check" CHECK ("merge_activation_finalize_queue"."dead_zone_knowledge_id" <> "merge_activation_finalize_queue"."canonical_knowledge_id"),
  CONSTRAINT "merge_activation_finalize_queue_payload_object_check" CHECK (jsonb_typeof("merge_activation_finalize_queue"."payload") = 'object'),
  CONSTRAINT "merge_activation_finalize_queue_metadata_object_check" CHECK (jsonb_typeof("merge_activation_finalize_queue"."metadata") = 'object'),
  CONSTRAINT "merge_activation_finalize_queue_input_snapshot_object_check" CHECK (jsonb_typeof("merge_activation_finalize_queue"."input_snapshot") = 'object'),
  CONSTRAINT "merge_activation_finalize_queue_activation_result_object_check" CHECK (jsonb_typeof("merge_activation_finalize_queue"."activation_result") = 'object')
);
--> statement-breakpoint
ALTER TABLE "merge_activation_finalize_queue" ADD CONSTRAINT "merge_activation_finalize_queue_merge_review_job_id_dead_zone_merge_review_queue_id_fk" FOREIGN KEY ("merge_review_job_id") REFERENCES "public"."dead_zone_merge_review_queue"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_activation_finalize_queue" ADD CONSTRAINT "merge_activation_finalize_queue_dead_zone_knowledge_id_knowledge_items_id_fk" FOREIGN KEY ("dead_zone_knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_activation_finalize_queue" ADD CONSTRAINT "merge_activation_finalize_queue_canonical_knowledge_id_knowledge_items_id_fk" FOREIGN KEY ("canonical_knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_activation_finalize_queue" ADD CONSTRAINT "merge_activation_finalize_queue_review_item_id_landscape_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."landscape_review_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_activation_finalize_queue" ADD CONSTRAINT "merge_activation_finalize_queue_knowledge_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "merge_activation_finalize_queue_status_priority_created_at_idx" ON "merge_activation_finalize_queue" USING btree ("status","priority","created_at");
--> statement-breakpoint
CREATE INDEX "merge_activation_finalize_queue_merge_review_job_idx" ON "merge_activation_finalize_queue" USING btree ("merge_review_job_id");
--> statement-breakpoint
CREATE INDEX "merge_activation_finalize_queue_dead_zone_status_idx" ON "merge_activation_finalize_queue" USING btree ("dead_zone_knowledge_id","status");
--> statement-breakpoint
CREATE INDEX "merge_activation_finalize_queue_canonical_status_idx" ON "merge_activation_finalize_queue" USING btree ("canonical_knowledge_id","status");
--> statement-breakpoint
CREATE INDEX "merge_activation_finalize_queue_review_item_status_idx" ON "merge_activation_finalize_queue" USING btree ("review_item_id","status");
--> statement-breakpoint
ALTER TABLE "distillation_queue_events" DROP CONSTRAINT IF EXISTS "distillation_queue_events_queue_name_check";
--> statement-breakpoint
ALTER TABLE "distillation_queue_events" ADD CONSTRAINT "distillation_queue_events_queue_name_check" CHECK ("distillation_queue_events"."queue_name" IN ('findingCandidate', 'coveringEvidence', 'deadZoneMergeReview', 'finalizeDistille', 'mergeActivationFinalize'));
