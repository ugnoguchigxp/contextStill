ALTER TABLE "context_compile_runs"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'unknown';

ALTER TABLE "context_compile_runs"
  ADD COLUMN IF NOT EXISTS "pack_snapshot" jsonb;

DO $$
BEGIN
  ALTER TABLE "context_compile_runs"
    ADD CONSTRAINT "context_compile_runs_source_check"
    CHECK ("source" IN ('ui','mcp','cli','unknown'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "context_compile_runs_source_idx"
  ON "context_compile_runs" ("source");
