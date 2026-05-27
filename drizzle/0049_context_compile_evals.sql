CREATE TABLE "context_compile_evals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "session_id" text,
  "score" integer NOT NULL,
  "outcome" text NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "source" text DEFAULT 'mcp' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "context_compile_evals_score_range_check" CHECK ("context_compile_evals"."score" >= 0 and "context_compile_evals"."score" <= 100),
  CONSTRAINT "context_compile_evals_outcome_check" CHECK ("context_compile_evals"."outcome" IN ('useful', 'partial', 'misleading', 'unused')),
  CONSTRAINT "context_compile_evals_source_check" CHECK ("context_compile_evals"."source" IN ('mcp', 'ui', 'system', 'import')),
  CONSTRAINT "context_compile_evals_body_length_check" CHECK (char_length("context_compile_evals"."body") <= 10000),
  CONSTRAINT "context_compile_evals_title_length_check" CHECK ("context_compile_evals"."title" is null or char_length("context_compile_evals"."title") <= 160)
);
--> statement-breakpoint
ALTER TABLE "context_compile_evals"
  ADD CONSTRAINT "context_compile_evals_run_id_context_compile_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."context_compile_runs"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "context_compile_evals_run_created_at_idx"
  ON "context_compile_evals" USING btree ("run_id", "created_at");
--> statement-breakpoint
CREATE INDEX "context_compile_evals_session_created_at_idx"
  ON "context_compile_evals" USING btree ("session_id", "created_at")
  WHERE "context_compile_evals"."session_id" is not null;
--> statement-breakpoint
CREATE INDEX "context_compile_evals_outcome_created_at_idx"
  ON "context_compile_evals" USING btree ("outcome", "created_at");
