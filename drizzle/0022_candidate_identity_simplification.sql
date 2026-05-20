DROP INDEX IF EXISTS "cover_evidence_results_find_candidate_result_unique_idx";
DROP INDEX IF EXISTS "cover_evidence_results_find_candidate_result_idx";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cover_evidence_results'
      AND column_name = 'find_candidate_result_id'
  ) THEN
    ALTER TABLE "cover_evidence_results" DROP CONSTRAINT IF EXISTS "cover_evidence_results_pkey";
    UPDATE "cover_evidence_results"
    SET "id" = "find_candidate_result_id";
    ALTER TABLE "cover_evidence_results" ADD PRIMARY KEY ("id");
    ALTER TABLE "cover_evidence_results" DROP COLUMN "find_candidate_result_id";
  END IF;

  ALTER TABLE "cover_evidence_results" ALTER COLUMN "id" DROP DEFAULT;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cover_evidence_results_id_find_candidate_results_id_fk'
  ) THEN
    ALTER TABLE "cover_evidence_results"
      ADD CONSTRAINT "cover_evidence_results_id_find_candidate_results_id_fk"
      FOREIGN KEY ("id") REFERENCES "find_candidate_results"("id") ON DELETE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS "find_candidate_results_dedupe_unique_idx";
DROP INDEX IF EXISTS "find_candidate_results_target_input_idx";
DROP INDEX IF EXISTS "find_candidate_results_candidate_hash_idx";

ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "input_hash";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "candidate_hash";

DELETE FROM "find_candidate_results" AS f
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "target_state_id", "candidate_index"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "find_candidate_results"
) AS ranked
WHERE f."id" = ranked."id"
  AND ranked.rn > 1;

CREATE INDEX IF NOT EXISTS "find_candidate_results_target_candidate_index_idx"
  ON "find_candidate_results" ("target_state_id", "candidate_index");
