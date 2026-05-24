CREATE TABLE "context_compile_task_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"retrieval_mode" text NOT NULL,
	"repo_path" text,
	"repo_key" text,
	"technologies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding_status" text DEFAULT 'facets_only' NOT NULL,
	"embedding_provider" text,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"embedding" vector(384),
	"goal_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "context_compile_task_traces_technologies_array_check" CHECK (jsonb_typeof("context_compile_task_traces"."technologies") = 'array'),
	CONSTRAINT "context_compile_task_traces_change_types_array_check" CHECK (jsonb_typeof("context_compile_task_traces"."change_types") = 'array'),
	CONSTRAINT "context_compile_task_traces_domains_array_check" CHECK (jsonb_typeof("context_compile_task_traces"."domains") = 'array'),
	CONSTRAINT "context_compile_task_traces_embedding_status_check" CHECK ("context_compile_task_traces"."embedding_status" IN ('facets_only', 'embedding_available', 'embedding_unavailable'))
);
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD CONSTRAINT "context_compile_task_traces_run_id_context_compile_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."context_compile_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "context_compile_task_traces_run_id_unique" ON "context_compile_task_traces" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "context_compile_task_traces_created_at_idx" ON "context_compile_task_traces" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "context_compile_task_traces_repo_path_idx" ON "context_compile_task_traces" USING btree ("repo_path");
--> statement-breakpoint
CREATE INDEX "context_compile_task_traces_repo_key_idx" ON "context_compile_task_traces" USING btree ("repo_key");
--> statement-breakpoint
CREATE INDEX "context_compile_task_traces_embedding_status_idx" ON "context_compile_task_traces" USING btree ("embedding_status");
--> statement-breakpoint
CREATE INDEX "context_compile_task_traces_goal_hash_idx" ON "context_compile_task_traces" USING btree ("goal_hash");
