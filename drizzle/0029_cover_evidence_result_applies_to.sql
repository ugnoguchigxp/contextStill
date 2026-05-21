ALTER TABLE "cover_evidence_results"
  ADD COLUMN IF NOT EXISTS "applies_to" jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE "cover_evidence_results"
SET "applies_to" = (COALESCE("applies_to", '{}'::jsonb) - 'retrievalModes' - 'domains' - 'files');
