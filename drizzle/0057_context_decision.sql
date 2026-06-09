CREATE TABLE "context_decision_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text,
  "task_goal" text NOT NULL,
  "decision_point" text NOT NULL,
  "proposed_action" text,
  "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "decision" text NOT NULL,
  "selected_action" text,
  "rejected_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "mandate" text NOT NULL,
  "agent_message" text NOT NULL,
  "confidence" integer NOT NULL,
  "confidence_trace" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "autonomy_level" text DEFAULT 'high' NOT NULL,
  "risk_budget" text DEFAULT 'medium' NOT NULL,
  "knowledge_policy" text DEFAULT 'optional' NOT NULL,
  "available_rollback" text,
  "verification_plan" text,
  "guardrails" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "unsupported_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_decision_runs_decision_check" CHECK ("context_decision_runs"."decision" IN ('execute', 'reject', 'revise_and_execute', 'rollback', 'discard', 'escalate')),
  CONSTRAINT "context_decision_runs_confidence_range_check" CHECK ("context_decision_runs"."confidence" >= 0 and "context_decision_runs"."confidence" <= 100),
  CONSTRAINT "context_decision_runs_autonomy_level_check" CHECK ("context_decision_runs"."autonomy_level" IN ('low', 'medium', 'high')),
  CONSTRAINT "context_decision_runs_risk_budget_check" CHECK ("context_decision_runs"."risk_budget" IN ('low', 'medium', 'high')),
  CONSTRAINT "context_decision_runs_knowledge_policy_check" CHECK ("context_decision_runs"."knowledge_policy" IN ('optional', 'required')),
  CONSTRAINT "context_decision_runs_status_check" CHECK ("context_decision_runs"."status" IN ('completed', 'degraded', 'failed')),
  CONSTRAINT "context_decision_runs_options_array_check" CHECK (jsonb_typeof("context_decision_runs"."options") = 'array'),
  CONSTRAINT "context_decision_runs_rejected_actions_array_check" CHECK (jsonb_typeof("context_decision_runs"."rejected_actions") = 'array'),
  CONSTRAINT "context_decision_runs_confidence_trace_object_check" CHECK (jsonb_typeof("context_decision_runs"."confidence_trace") = 'object'),
  CONSTRAINT "context_decision_runs_guardrails_object_check" CHECK (jsonb_typeof("context_decision_runs"."guardrails") = 'object'),
  CONSTRAINT "context_decision_runs_unsupported_alternatives_array_check" CHECK (jsonb_typeof("context_decision_runs"."unsupported_alternatives") = 'array'),
  CONSTRAINT "context_decision_runs_metadata_object_check" CHECK (jsonb_typeof("context_decision_runs"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_decision_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_run_id" uuid NOT NULL,
  "knowledge_id" uuid,
  "role" text NOT NULL,
  "weight_at_decision" integer NOT NULL,
  "dynamic_score_at_decision" integer,
  "applicability_score" integer,
  "temporal_relevance" integer,
  "summary" text NOT NULL,
  "source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_decision_evidence_role_check" CHECK ("context_decision_evidence"."role" IN ('selected_support', 'rejected_alternative', 'user_preference', 'risk_warning', 'missing_counter_evidence')),
  CONSTRAINT "context_decision_evidence_source_refs_array_check" CHECK (jsonb_typeof("context_decision_evidence"."source_refs") = 'array'),
  CONSTRAINT "context_decision_evidence_metadata_object_check" CHECK (jsonb_typeof("context_decision_evidence"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_decision_coverage_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_run_id" uuid NOT NULL,
  "query" text NOT NULL,
  "query_role" text NOT NULL,
  "scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "hit_count" integer DEFAULT 0 NOT NULL,
  "max_similarity" integer,
  "selected_knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rejected_knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_decision_coverage_query_role_check" CHECK ("context_decision_coverage_traces"."query_role" IN ('support', 'counter_evidence', 'user_preference', 'risk')),
  CONSTRAINT "context_decision_coverage_scope_object_check" CHECK (jsonb_typeof("context_decision_coverage_traces"."scope") = 'object'),
  CONSTRAINT "context_decision_coverage_selected_knowledge_ids_array_check" CHECK (jsonb_typeof("context_decision_coverage_traces"."selected_knowledge_ids") = 'array'),
  CONSTRAINT "context_decision_coverage_rejected_knowledge_ids_array_check" CHECK (jsonb_typeof("context_decision_coverage_traces"."rejected_knowledge_ids") = 'array')
);
--> statement-breakpoint
CREATE TABLE "context_decision_human_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_run_id" uuid NOT NULL,
  "value" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_decision_human_feedback_run_unique" UNIQUE("decision_run_id"),
  CONSTRAINT "context_decision_human_feedback_value_check" CHECK ("context_decision_human_feedback"."value" IN ('good', 'bad'))
);
--> statement-breakpoint
CREATE TABLE "context_decision_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_run_id" uuid NOT NULL,
  "source" text NOT NULL,
  "outcome" text NOT NULL,
  "inferred_reason" text NOT NULL,
  "affected_knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "suggested_adjustment" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_decision_feedback_source_check" CHECK ("context_decision_feedback"."source" IN ('ai', 'system')),
  CONSTRAINT "context_decision_feedback_outcome_check" CHECK ("context_decision_feedback"."outcome" IN ('success', 'failed', 'discarded_pr', 'user_overrode', 'regression_found', 'still_unknown')),
  CONSTRAINT "context_decision_feedback_affected_knowledge_ids_array_check" CHECK (jsonb_typeof("context_decision_feedback"."affected_knowledge_ids") = 'array'),
  CONSTRAINT "context_decision_feedback_suggested_adjustment_object_check" CHECK (jsonb_typeof("context_decision_feedback"."suggested_adjustment") = 'object'),
  CONSTRAINT "context_decision_feedback_metadata_object_check" CHECK (jsonb_typeof("context_decision_feedback"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "context_decision_feedback_effects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "feedback_id" uuid,
  "human_feedback_id" uuid,
  "decision_run_id" uuid NOT NULL,
  "knowledge_id" uuid,
  "effect" text NOT NULL,
  "amount" integer NOT NULL,
  "reason" text NOT NULL,
  "confidence" integer NOT NULL,
  "status" text DEFAULT 'applied' NOT NULL,
  "applied_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_decision_feedback_effects_effect_check" CHECK ("context_decision_feedback_effects"."effect" IN ('boost', 'penalize', 'neutral')),
  CONSTRAINT "context_decision_feedback_effects_confidence_range_check" CHECK ("context_decision_feedback_effects"."confidence" >= 0 and "context_decision_feedback_effects"."confidence" <= 100),
  CONSTRAINT "context_decision_feedback_effects_status_check" CHECK ("context_decision_feedback_effects"."status" IN ('applied', 'queued_for_review', 'skipped')),
  CONSTRAINT "context_decision_feedback_effects_source_check" CHECK ((("context_decision_feedback_effects"."feedback_id" is not null and "context_decision_feedback_effects"."human_feedback_id" is null) or ("context_decision_feedback_effects"."feedback_id" is null and "context_decision_feedback_effects"."human_feedback_id" is not null))),
  CONSTRAINT "context_decision_feedback_effects_metadata_object_check" CHECK (jsonb_typeof("context_decision_feedback_effects"."metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "context_decision_evidence" ADD CONSTRAINT "context_decision_evidence_decision_run_id_context_decision_runs_id_fk" FOREIGN KEY ("decision_run_id") REFERENCES "public"."context_decision_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_evidence" ADD CONSTRAINT "context_decision_evidence_knowledge_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_coverage_traces" ADD CONSTRAINT "context_decision_coverage_traces_decision_run_id_context_decision_runs_id_fk" FOREIGN KEY ("decision_run_id") REFERENCES "public"."context_decision_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_human_feedback" ADD CONSTRAINT "context_decision_human_feedback_decision_run_id_context_decision_runs_id_fk" FOREIGN KEY ("decision_run_id") REFERENCES "public"."context_decision_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_feedback" ADD CONSTRAINT "context_decision_feedback_decision_run_id_context_decision_runs_id_fk" FOREIGN KEY ("decision_run_id") REFERENCES "public"."context_decision_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_feedback_effects" ADD CONSTRAINT "context_decision_feedback_effects_feedback_id_context_decision_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."context_decision_feedback"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_feedback_effects" ADD CONSTRAINT "context_decision_feedback_effects_human_feedback_id_context_decision_human_feedback_id_fk" FOREIGN KEY ("human_feedback_id") REFERENCES "public"."context_decision_human_feedback"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_feedback_effects" ADD CONSTRAINT "context_decision_feedback_effects_decision_run_id_context_decision_runs_id_fk" FOREIGN KEY ("decision_run_id") REFERENCES "public"."context_decision_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_decision_feedback_effects" ADD CONSTRAINT "context_decision_feedback_effects_knowledge_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "context_decision_runs_created_at_idx" ON "context_decision_runs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "context_decision_runs_decision_created_at_idx" ON "context_decision_runs" USING btree ("decision","created_at");
--> statement-breakpoint
CREATE INDEX "context_decision_runs_status_created_at_idx" ON "context_decision_runs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "context_decision_runs_session_created_at_idx" ON "context_decision_runs" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "context_decision_evidence_decision_role_idx" ON "context_decision_evidence" USING btree ("decision_run_id","role");
--> statement-breakpoint
CREATE INDEX "context_decision_evidence_knowledge_role_idx" ON "context_decision_evidence" USING btree ("knowledge_id","role");
--> statement-breakpoint
CREATE INDEX "context_decision_coverage_decision_role_idx" ON "context_decision_coverage_traces" USING btree ("decision_run_id","query_role");
--> statement-breakpoint
CREATE INDEX "context_decision_feedback_run_idx" ON "context_decision_feedback" USING btree ("decision_run_id");
--> statement-breakpoint
CREATE INDEX "context_decision_feedback_outcome_created_at_idx" ON "context_decision_feedback" USING btree ("outcome","created_at");
--> statement-breakpoint
CREATE INDEX "context_decision_feedback_effects_run_status_idx" ON "context_decision_feedback_effects" USING btree ("decision_run_id","status");
--> statement-breakpoint
CREATE INDEX "context_decision_feedback_effects_knowledge_status_idx" ON "context_decision_feedback_effects" USING btree ("knowledge_id","status");
