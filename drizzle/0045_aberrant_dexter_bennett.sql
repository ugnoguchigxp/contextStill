CREATE TABLE "finding_candidate_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_kind" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_key" text NOT NULL,
	"source_uri" text NOT NULL,
	"distillation_version" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
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
	CONSTRAINT "finding_candidate_queue_status_check" CHECK ("finding_candidate_queue"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
	CONSTRAINT "finding_candidate_queue_input_kind_check" CHECK ("finding_candidate_queue"."input_kind" IN ('source_target', 'provided_candidate')),
	CONSTRAINT "finding_candidate_queue_source_kind_check" CHECK ("finding_candidate_queue"."source_kind" IN ('wiki_file', 'vibe_memory', 'knowledge_candidate', 'web_ingest')),
	CONSTRAINT "finding_candidate_queue_payload_object_check" CHECK (jsonb_typeof("finding_candidate_queue"."payload") = 'object'),
	CONSTRAINT "finding_candidate_queue_metadata_object_check" CHECK (jsonb_typeof("finding_candidate_queue"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "found_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_job_id" uuid NOT NULL,
	"candidate_index" integer NOT NULL,
	"type" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source_summary" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "found_candidates_origin_object_check" CHECK (jsonb_typeof("found_candidates"."origin") = 'object'),
	CONSTRAINT "found_candidates_metadata_object_check" CHECK (jsonb_typeof("found_candidates"."metadata") = 'object'),
	CONSTRAINT "found_candidates_type_check" CHECK ("found_candidates"."type" IS NULL OR "found_candidates"."type" IN ('rule', 'procedure'))
);
--> statement-breakpoint
CREATE TABLE "covering_evidence_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"found_candidate_id" uuid NOT NULL,
	"distillation_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"provider_policy" text DEFAULT 'default' NOT NULL,
	"next_run_at" timestamp,
	"locked_by" text,
	"locked_at" timestamp,
	"heartbeat_at" timestamp,
	"last_error" text,
	"last_outcome_kind" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "covering_evidence_queue_status_check" CHECK ("covering_evidence_queue"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
	CONSTRAINT "covering_evidence_queue_provider_policy_check" CHECK ("covering_evidence_queue"."provider_policy" IN ('default', 'cloud_api')),
	CONSTRAINT "covering_evidence_queue_payload_object_check" CHECK (jsonb_typeof("covering_evidence_queue"."payload") = 'object'),
	CONSTRAINT "covering_evidence_queue_metadata_object_check" CHECK (jsonb_typeof("covering_evidence_queue"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "premium_covering_evidence_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"found_candidate_id" uuid NOT NULL,
	"source_covering_job_id" uuid,
	"distillation_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"provider_policy" text DEFAULT 'cloud_api' NOT NULL,
	"next_run_at" timestamp,
	"locked_by" text,
	"locked_at" timestamp,
	"heartbeat_at" timestamp,
	"last_error" text,
	"last_outcome_kind" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "premium_covering_evidence_queue_status_check" CHECK ("premium_covering_evidence_queue"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
	CONSTRAINT "premium_covering_evidence_queue_provider_policy_check" CHECK ("premium_covering_evidence_queue"."provider_policy" IN ('default', 'cloud_api')),
	CONSTRAINT "premium_covering_evidence_queue_payload_object_check" CHECK (jsonb_typeof("premium_covering_evidence_queue"."payload") = 'object'),
	CONSTRAINT "premium_covering_evidence_queue_metadata_object_check" CHECK (jsonb_typeof("premium_covering_evidence_queue"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "evidence_coverage_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"found_candidate_id" uuid NOT NULL,
	"producer_queue" text NOT NULL,
	"producer_job_id" uuid NOT NULL,
	"distillation_version" text NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"type" text,
	"title" text,
	"body" text,
	"importance" real,
	"confidence" real,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_coverage_results_producer_queue_check" CHECK ("evidence_coverage_results"."producer_queue" IN ('coveringEvidence', 'premiumCoveringEvidence')),
	CONSTRAINT "evidence_coverage_results_status_check" CHECK ("evidence_coverage_results"."status" IN ('knowledge_ready', 'duplicate', 'near_duplicate', 'insufficient', 'parse_failed', 'tool_failed', 'provider_failed')),
	CONSTRAINT "evidence_coverage_results_stage_check" CHECK ("evidence_coverage_results"."stage" IN ('load', 'source_support', 'dedupe', 'evidence_need', 'web', 'mcp', 'final')),
	CONSTRAINT "evidence_coverage_results_type_check" CHECK ("evidence_coverage_results"."type" IS NULL OR "evidence_coverage_results"."type" IN ('rule', 'procedure')),
	CONSTRAINT "evidence_coverage_results_applies_to_object_check" CHECK (jsonb_typeof("evidence_coverage_results"."applies_to") = 'object'),
	CONSTRAINT "evidence_coverage_results_references_array_check" CHECK (jsonb_typeof("evidence_coverage_results"."references") = 'array'),
	CONSTRAINT "evidence_coverage_results_duplicate_refs_array_check" CHECK (jsonb_typeof("evidence_coverage_results"."duplicate_refs") = 'array'),
	CONSTRAINT "evidence_coverage_results_tool_events_array_check" CHECK (jsonb_typeof("evidence_coverage_results"."tool_events") = 'array'),
	CONSTRAINT "evidence_coverage_results_metadata_object_check" CHECK (jsonb_typeof("evidence_coverage_results"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "finalize_distille_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_result_id" uuid NOT NULL,
	"distillation_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_policy" text DEFAULT 'default' NOT NULL,
	"locked_by" text,
	"locked_at" timestamp,
	"heartbeat_at" timestamp,
	"last_error" text,
	"last_outcome_kind" text,
	"knowledge_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "finalize_distille_queue_status_check" CHECK ("finalize_distille_queue"."status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
	CONSTRAINT "finalize_distille_queue_provider_policy_check" CHECK ("finalize_distille_queue"."provider_policy" IN ('default', 'cloud_api')),
	CONSTRAINT "finalize_distille_queue_metadata_object_check" CHECK (jsonb_typeof("finalize_distille_queue"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "distillation_queue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_name" text NOT NULL,
	"queue_job_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "distillation_queue_events_queue_name_check" CHECK ("distillation_queue_events"."queue_name" IN ('findingCandidate', 'coveringEvidence', 'premiumCoveringEvidence', 'finalizeDistille')),
	CONSTRAINT "distillation_queue_events_event_type_check" CHECK ("distillation_queue_events"."event_type" IN ('claimed', 'completed', 'paused', 'resumed', 'retried', 'reprocess_requested', 'escalated_to_premium', 'enqueued', 'migration_mapped', 'migration_failed')),
	CONSTRAINT "distillation_queue_events_metadata_object_check" CHECK (jsonb_typeof("distillation_queue_events"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "distillation_queue_migration_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"legacy_target_state_id" uuid,
	"legacy_find_candidate_result_id" uuid,
	"legacy_cover_evidence_result_id" uuid,
	"legacy_target_kind" text,
	"legacy_target_key" text,
	"distillation_version" text,
	"finding_job_id" uuid,
	"found_candidate_id" uuid,
	"covering_job_id" uuid,
	"premium_job_id" uuid,
	"evidence_result_id" uuid,
	"finalize_job_id" uuid,
	"migration_run_id" text,
	"migration_status" text DEFAULT 'migrated' NOT NULL,
	"skip_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "distillation_queue_migration_map_status_check" CHECK ("distillation_queue_migration_map"."migration_status" IN ('migrated', 'skipped', 'failed')),
	CONSTRAINT "distillation_queue_migration_map_metadata_object_check" CHECK (jsonb_typeof("distillation_queue_migration_map"."metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ALTER COLUMN "target_state_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ALTER COLUMN "find_candidate_result_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD COLUMN IF NOT EXISTS "finding_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD COLUMN IF NOT EXISTS "found_candidate_id" uuid;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD COLUMN IF NOT EXISTS "evidence_result_id" uuid;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD COLUMN IF NOT EXISTS "legacy_target_state_id" uuid;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD COLUMN IF NOT EXISTS "legacy_find_candidate_result_id" uuid;
--> statement-breakpoint
ALTER TABLE "found_candidates" ADD CONSTRAINT "found_candidates_finding_job_id_finding_candidate_queue_id_fk" FOREIGN KEY ("finding_job_id") REFERENCES "public"."finding_candidate_queue"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "covering_evidence_queue" ADD CONSTRAINT "covering_evidence_queue_found_candidate_id_found_candidates_id_fk" FOREIGN KEY ("found_candidate_id") REFERENCES "public"."found_candidates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "premium_covering_evidence_queue" ADD CONSTRAINT "premium_covering_evidence_queue_found_candidate_id_found_candidates_id_fk" FOREIGN KEY ("found_candidate_id") REFERENCES "public"."found_candidates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "premium_covering_evidence_queue" ADD CONSTRAINT "premium_covering_evidence_queue_source_covering_job_id_covering_evidence_queue_id_fk" FOREIGN KEY ("source_covering_job_id") REFERENCES "public"."covering_evidence_queue"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_coverage_results" ADD CONSTRAINT "evidence_coverage_results_found_candidate_id_found_candidates_id_fk" FOREIGN KEY ("found_candidate_id") REFERENCES "public"."found_candidates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finalize_distille_queue" ADD CONSTRAINT "finalize_distille_queue_evidence_result_id_evidence_coverage_results_id_fk" FOREIGN KEY ("evidence_result_id") REFERENCES "public"."evidence_coverage_results"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "distillation_queue_migration_map" ADD CONSTRAINT "distillation_queue_migration_map_finding_job_id_finding_candidate_queue_id_fk" FOREIGN KEY ("finding_job_id") REFERENCES "public"."finding_candidate_queue"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "distillation_queue_migration_map" ADD CONSTRAINT "distillation_queue_migration_map_found_candidate_id_found_candidates_id_fk" FOREIGN KEY ("found_candidate_id") REFERENCES "public"."found_candidates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "distillation_queue_migration_map" ADD CONSTRAINT "distillation_queue_migration_map_covering_job_id_covering_evidence_queue_id_fk" FOREIGN KEY ("covering_job_id") REFERENCES "public"."covering_evidence_queue"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "distillation_queue_migration_map" ADD CONSTRAINT "distillation_queue_migration_map_premium_job_id_premium_covering_evidence_queue_id_fk" FOREIGN KEY ("premium_job_id") REFERENCES "public"."premium_covering_evidence_queue"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "distillation_queue_migration_map" ADD CONSTRAINT "distillation_queue_migration_map_evidence_result_id_evidence_coverage_results_id_fk" FOREIGN KEY ("evidence_result_id") REFERENCES "public"."evidence_coverage_results"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "distillation_queue_migration_map" ADD CONSTRAINT "distillation_queue_migration_map_finalize_job_id_finalize_distille_queue_id_fk" FOREIGN KEY ("finalize_job_id") REFERENCES "public"."finalize_distille_queue"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD CONSTRAINT "landscape_review_item_candidate_links_finding_job_id_finding_candidate_queue_id_fk" FOREIGN KEY ("finding_job_id") REFERENCES "public"."finding_candidate_queue"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD CONSTRAINT "landscape_review_item_candidate_links_found_candidate_id_found_candidates_id_fk" FOREIGN KEY ("found_candidate_id") REFERENCES "public"."found_candidates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "landscape_review_item_candidate_links" ADD CONSTRAINT "landscape_review_item_candidate_links_evidence_result_id_evidence_coverage_results_id_fk" FOREIGN KEY ("evidence_result_id") REFERENCES "public"."evidence_coverage_results"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "finding_candidate_queue_unique_idx" ON "finding_candidate_queue" USING btree ("input_kind","source_kind","source_key","distillation_version");
--> statement-breakpoint
CREATE INDEX "finding_candidate_queue_status_priority_created_at_idx" ON "finding_candidate_queue" USING btree ("status","priority","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "found_candidates_finding_candidate_unique_idx" ON "found_candidates" USING btree ("finding_job_id","candidate_index");
--> statement-breakpoint
CREATE INDEX "found_candidates_finding_job_idx" ON "found_candidates" USING btree ("finding_job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "covering_evidence_queue_found_candidate_unique_idx" ON "covering_evidence_queue" USING btree ("found_candidate_id");
--> statement-breakpoint
CREATE INDEX "covering_evidence_queue_status_priority_created_at_idx" ON "covering_evidence_queue" USING btree ("status","priority","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "premium_covering_evidence_queue_found_candidate_unique_idx" ON "premium_covering_evidence_queue" USING btree ("found_candidate_id");
--> statement-breakpoint
CREATE INDEX "premium_covering_evidence_queue_status_priority_created_at_idx" ON "premium_covering_evidence_queue" USING btree ("status","priority","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_coverage_results_found_candidate_producer_unique_idx" ON "evidence_coverage_results" USING btree ("found_candidate_id","producer_queue");
--> statement-breakpoint
CREATE INDEX "evidence_coverage_results_status_idx" ON "evidence_coverage_results" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "finalize_distille_queue_evidence_result_unique_idx" ON "finalize_distille_queue" USING btree ("evidence_result_id");
--> statement-breakpoint
CREATE INDEX "finalize_distille_queue_status_priority_created_at_idx" ON "finalize_distille_queue" USING btree ("status","priority","created_at");
--> statement-breakpoint
CREATE INDEX "distillation_queue_events_name_type_created_at_idx" ON "distillation_queue_events" USING btree ("queue_name","event_type","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "distillation_queue_migration_map_idempotency_unique_idx" ON "distillation_queue_migration_map" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "distillation_queue_migration_map_status_idx" ON "distillation_queue_migration_map" USING btree ("migration_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "landscape_review_item_candidate_links_queue_candidate_unique" ON "landscape_review_item_candidate_links" USING btree ("finding_job_id","found_candidate_id");
--> statement-breakpoint
CREATE INDEX "landscape_review_item_candidate_links_finding_job_idx" ON "landscape_review_item_candidate_links" USING btree ("finding_job_id");
--> statement-breakpoint
CREATE INDEX "landscape_review_item_candidate_links_found_candidate_idx" ON "landscape_review_item_candidate_links" USING btree ("found_candidate_id");
--> statement-breakpoint
CREATE INDEX "landscape_review_item_candidate_links_evidence_result_idx" ON "landscape_review_item_candidate_links" USING btree ("evidence_result_id");
