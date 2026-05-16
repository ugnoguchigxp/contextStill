ALTER TABLE "vibe_memory_distillation_runs"
ADD COLUMN IF NOT EXISTS "tool_events" jsonb DEFAULT '[]'::jsonb NOT NULL;
