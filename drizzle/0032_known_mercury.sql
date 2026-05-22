CREATE TABLE IF NOT EXISTS "llm_usage_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "prompt_tokens" integer NOT NULL,
  "completion_tokens" integer NOT NULL,
  "total_tokens" integer NOT NULL,
  "reasoning_tokens" integer DEFAULT 0 NOT NULL,
  "cost_jpy" real DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'unknown' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_logs_created_at_idx" ON "llm_usage_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_logs_provider_idx" ON "llm_usage_logs" USING btree ("provider");
