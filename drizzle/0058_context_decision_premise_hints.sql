ALTER TABLE "context_decision_runs" ADD COLUMN "premise" text;
--> statement-breakpoint
ALTER TABLE "context_decision_runs" ADD COLUMN "retrieval_hints" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "context_decision_runs"
SET "premise" = "task_goal"
WHERE "premise" IS NULL AND "task_goal" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_decision_runs" DROP COLUMN "task_goal";
--> statement-breakpoint
ALTER TABLE "context_decision_runs" ADD CONSTRAINT "context_decision_runs_retrieval_hints_object_check" CHECK (jsonb_typeof("context_decision_runs"."retrieval_hints") = 'object');
