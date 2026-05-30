CREATE TABLE "vibe_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_uri" text NOT NULL,
	"goal_anchor_ref" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vibe_goals_goal_uri_unique" UNIQUE("goal_uri")
);
--> statement-breakpoint
CREATE TABLE "vibe_memory_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" text NOT NULL,
	"target_memory_id" uuid NOT NULL,
	"mark" text NOT NULL,
	"note" text,
	"actor_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vibe_migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_table" text NOT NULL,
	"deleted_count" integer NOT NULL,
	"preserved_tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"executed_at" timestamp DEFAULT now() NOT NULL,
	"app_version" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "wants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "evidence_status" text;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD COLUMN "ttl_at" timestamp;--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "relevance" integer;--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "actionability" integer;--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "coverage" integer;--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "noise" integer;--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD COLUMN "specificity" integer;--> statement-breakpoint
ALTER TABLE "vibe_memory_marks" ADD CONSTRAINT "vibe_memory_marks_goal_id_vibe_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."vibe_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vibe_memory_marks" ADD CONSTRAINT "vibe_memory_marks_target_memory_id_vibe_memories_id_fk" FOREIGN KEY ("target_memory_id") REFERENCES "public"."vibe_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vibe_memory_marks_goal_id_idx" ON "vibe_memory_marks" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "vibe_memory_marks_target_memory_id_idx" ON "vibe_memory_marks" USING btree ("target_memory_id");--> statement-breakpoint
CREATE INDEX "vibe_memory_marks_mark_idx" ON "vibe_memory_marks" USING btree ("mark");--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD CONSTRAINT "vibe_memories_goal_id_vibe_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."vibe_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD CONSTRAINT "vibe_memories_parent_id_vibe_memories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."vibe_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vibe_memories_goal_id_idx" ON "vibe_memories" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "vibe_memories_parent_id_idx" ON "vibe_memories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "vibe_memories_intent_idx" ON "vibe_memories" USING btree ("intent");--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_relevance_range_check" CHECK ("context_compile_evals"."relevance" is null or ("context_compile_evals"."relevance" >= 0 and "context_compile_evals"."relevance" <= 100));--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_actionability_range_check" CHECK ("context_compile_evals"."actionability" is null or ("context_compile_evals"."actionability" >= 0 and "context_compile_evals"."actionability" <= 100));--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_coverage_range_check" CHECK ("context_compile_evals"."coverage" is null or ("context_compile_evals"."coverage" >= 0 and "context_compile_evals"."coverage" <= 100));--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_noise_range_check" CHECK ("context_compile_evals"."noise" is null or ("context_compile_evals"."noise" >= 0 and "context_compile_evals"."noise" <= 100));--> statement-breakpoint
ALTER TABLE "context_compile_evals" ADD CONSTRAINT "context_compile_evals_specificity_range_check" CHECK ("context_compile_evals"."specificity" is null or ("context_compile_evals"."specificity" >= 0 and "context_compile_evals"."specificity" <= 100));