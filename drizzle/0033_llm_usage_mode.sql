ALTER TABLE "llm_usage_logs"
ADD COLUMN IF NOT EXISTS "usage_mode" text DEFAULT 'estimated' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_usage_logs_usage_mode_check'
  ) THEN
    ALTER TABLE "llm_usage_logs"
    ADD CONSTRAINT "llm_usage_logs_usage_mode_check"
    CHECK ("usage_mode" IN ('measured', 'estimated'));
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_logs_source_idx" ON "llm_usage_logs" USING btree ("source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_logs_usage_mode_idx" ON "llm_usage_logs" USING btree ("usage_mode");
