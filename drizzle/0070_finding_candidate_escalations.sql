CREATE TABLE IF NOT EXISTS "finding_candidate_escalations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_kind" text NOT NULL,
  "source_key" text NOT NULL,
  "distillation_version" text NOT NULL,
  "source_dedupe_key" text,
  "primary_job_id" uuid,
  "escalation_provider" text NOT NULL,
  "escalation_model" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "output_summary" text,
  "candidate_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finding_candidate_escalations" ADD CONSTRAINT "finding_candidate_escalations_primary_job_id_finding_candidate_queue_id_fk" FOREIGN KEY ("primary_job_id") REFERENCES "public"."finding_candidate_queue"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finding_candidate_escalations_source_provider_model_unique_idx" ON "finding_candidate_escalations" USING btree ("source_kind","source_key","distillation_version","escalation_provider","escalation_model");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finding_candidate_escalations_source_dedupe_idx" ON "finding_candidate_escalations" USING btree ("source_dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finding_candidate_escalations_primary_job_idx" ON "finding_candidate_escalations" USING btree ("primary_job_id");
