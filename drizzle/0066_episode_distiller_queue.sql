CREATE TABLE "episode_distiller_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text DEFAULT 'vibe_memory' NOT NULL,
  "source_key" text NOT NULL,
  "source_uri" text NOT NULL,
  "distillation_version" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" integer DEFAULT 50 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 2 NOT NULL,
  "provider_policy" text DEFAULT 'default',
  "next_run_at" timestamp,
  "locked_by" text,
  "locked_at" timestamp,
  "heartbeat_at" timestamp,
  "last_error" text,
  "last_outcome_kind" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "episode_distiller_queue_status_check" CHECK ("episode_distiller_queue"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
  CONSTRAINT "episode_distiller_queue_source_kind_check" CHECK ("episode_distiller_queue"."source_kind" = 'vibe_memory'),
  CONSTRAINT "episode_distiller_queue_payload_object_check" CHECK (jsonb_typeof("episode_distiller_queue"."payload") = 'object'),
  CONSTRAINT "episode_distiller_queue_metadata_object_check" CHECK (jsonb_typeof("episode_distiller_queue"."metadata") = 'object'),
  CONSTRAINT "episode_distiller_queue_provider_policy_check" CHECK ("episode_distiller_queue"."provider_policy" IS NULL OR "episode_distiller_queue"."provider_policy" IN ('default', 'cloud_api'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "episode_distiller_queue_unique_idx" ON "episode_distiller_queue" USING btree ("source_kind","source_key","distillation_version");
--> statement-breakpoint
CREATE INDEX "episode_distiller_queue_status_priority_created_at_idx" ON "episode_distiller_queue" USING btree ("status","priority","created_at");
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_queue_name_check";
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_queue_name_check"
  CHECK ("distillation_queue_events"."queue_name" IN ('findingCandidate', 'episodeDistiller', 'coveringEvidence', 'deadZoneMergeReview', 'finalizeDistille', 'mergeActivationFinalize'));
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_event_type_check";
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_event_type_check"
  CHECK ("distillation_queue_events"."event_type" IN ('claimed', 'completed', 'failed', 'paused', 'resumed', 'retried', 'reprocess_requested', 'enqueued', 'migration_mapped', 'migration_failed'));
