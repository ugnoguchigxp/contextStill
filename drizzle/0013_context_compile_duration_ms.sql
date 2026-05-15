ALTER TABLE "context_compile_runs"
ADD COLUMN IF NOT EXISTS "duration_ms" integer NOT NULL DEFAULT 0;
