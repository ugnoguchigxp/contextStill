ALTER TABLE IF EXISTS "context_pack_items"
  ADD COLUMN IF NOT EXISTS "source_refs" jsonb NOT NULL DEFAULT '[]'::jsonb;
