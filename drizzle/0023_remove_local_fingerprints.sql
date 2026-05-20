DROP INDEX IF EXISTS "vibe_memory_distillation_runs_memory_prompt_hash_idx";
DROP INDEX IF EXISTS "vibe_memory_distillation_runs_memory_prompt_version_idx";

DELETE FROM "vibe_memory_distillation_runs" AS r
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "vibe_memory_id", "prompt_version"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "vibe_memory_distillation_runs"
) AS ranked
WHERE r."id" = ranked."id"
  AND ranked.rn > 1;

ALTER TABLE "vibe_memory_distillation_runs" DROP COLUMN IF EXISTS "input_hash";

CREATE UNIQUE INDEX IF NOT EXISTS "vibe_memory_distillation_runs_memory_prompt_version_idx"
  ON "vibe_memory_distillation_runs" ("vibe_memory_id", "prompt_version");

DROP INDEX IF EXISTS "sources_uri_hash_idx";
DROP INDEX IF EXISTS "sources_content_hash_idx";
ALTER TABLE "sources" DROP COLUMN IF EXISTS "content_hash";

DROP INDEX IF EXISTS "source_distillation_runs_fragment_prompt_hash_idx";
DROP INDEX IF EXISTS "source_distillation_runs_fragment_prompt_version_idx";

DELETE FROM "source_distillation_runs" AS r
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "source_fragment_id", "prompt_version"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "source_distillation_runs"
) AS ranked
WHERE r."id" = ranked."id"
  AND ranked.rn > 1;

ALTER TABLE "source_distillation_runs" DROP COLUMN IF EXISTS "input_hash";

CREATE UNIQUE INDEX IF NOT EXISTS "source_distillation_runs_fragment_prompt_version_idx"
  ON "source_distillation_runs" ("source_fragment_id", "prompt_version");

DROP TABLE IF EXISTS "source_distillation_evidence";

DROP INDEX IF EXISTS "distillation_target_states_target_unique_idx";

DELETE FROM "distillation_target_states" AS t
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "target_kind", "target_key", "distillation_version"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "distillation_target_states"
) AS ranked
WHERE t."id" = ranked."id"
  AND ranked.rn > 1;

ALTER TABLE "distillation_target_states" DROP COLUMN IF EXISTS "input_hash";

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_target_states_target_unique_idx"
  ON "distillation_target_states" ("target_kind", "target_key", "distillation_version");

DROP INDEX IF EXISTS "distillation_jobs_vibe_unique_idx";
DROP INDEX IF EXISTS "distillation_jobs_source_unique_idx";

DELETE FROM "distillation_jobs" AS j
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "vibe_memory_id", "prompt_version"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "distillation_jobs"
  WHERE "vibe_memory_id" IS NOT NULL
) AS ranked
WHERE j."id" = ranked."id"
  AND ranked.rn > 1;

DELETE FROM "distillation_jobs" AS j
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "source_fragment_id", "prompt_version"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "distillation_jobs"
  WHERE "source_fragment_id" IS NOT NULL
) AS ranked
WHERE j."id" = ranked."id"
  AND ranked.rn > 1;

ALTER TABLE "distillation_jobs" DROP COLUMN IF EXISTS "input_hash";
ALTER TABLE "distillation_jobs" DROP COLUMN IF EXISTS "budget";
ALTER TABLE "distillation_jobs" DROP COLUMN IF EXISTS "budget_used";

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_jobs_vibe_unique_idx"
  ON "distillation_jobs" ("vibe_memory_id", "prompt_version")
  WHERE "vibe_memory_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_jobs_source_unique_idx"
  ON "distillation_jobs" ("source_fragment_id", "prompt_version")
  WHERE "source_fragment_id" IS NOT NULL;

DROP INDEX IF EXISTS "distillation_evidence_cache_query_hash_idx";
DROP INDEX IF EXISTS "distillation_evidence_cache_query_text_idx";
DROP INDEX IF EXISTS "distillation_evidence_cache_lookup_idx";

UPDATE "distillation_evidence_cache"
SET "query_text" = COALESCE(NULLIF("query_text", ''), NULLIF("url", ''), "tool_name")
WHERE "query_text" IS NULL OR "query_text" = '';

DELETE FROM "distillation_evidence_cache" AS c
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "tool_name", "query_text", COALESCE("url", '')
      ORDER BY "fetched_at" DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "distillation_evidence_cache"
) AS ranked
WHERE c."id" = ranked."id"
  AND ranked.rn > 1;

ALTER TABLE "distillation_evidence_cache" ALTER COLUMN "query_text" SET NOT NULL;
ALTER TABLE "distillation_evidence_cache" DROP COLUMN IF EXISTS "query_hash";
ALTER TABLE "distillation_evidence_cache" DROP COLUMN IF EXISTS "content_hash";

CREATE INDEX IF NOT EXISTS "distillation_evidence_cache_query_text_idx"
  ON "distillation_evidence_cache" ("query_text");

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_evidence_cache_lookup_idx"
  ON "distillation_evidence_cache" ("tool_name", "query_text", "url");

DROP INDEX IF EXISTS "distillation_candidates_vibe_candidate_unique_idx";
DROP INDEX IF EXISTS "distillation_candidates_source_candidate_unique_idx";

DELETE FROM "distillation_candidates" AS c
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "vibe_memory_id", "prompt_version", "candidate_index"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "distillation_candidates"
  WHERE "vibe_memory_id" IS NOT NULL
) AS ranked
WHERE c."id" = ranked."id"
  AND ranked.rn > 1;

DELETE FROM "distillation_candidates" AS c
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "source_fragment_id", "prompt_version", "candidate_index"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "distillation_candidates"
  WHERE "source_fragment_id" IS NOT NULL
) AS ranked
WHERE c."id" = ranked."id"
  AND ranked.rn > 1;

ALTER TABLE "distillation_candidates" DROP COLUMN IF EXISTS "input_hash";

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_candidates_vibe_candidate_unique_idx"
  ON "distillation_candidates" ("vibe_memory_id", "prompt_version", "candidate_index")
  WHERE "vibe_memory_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "distillation_candidates_source_candidate_unique_idx"
  ON "distillation_candidates" ("source_fragment_id", "prompt_version", "candidate_index")
  WHERE "source_fragment_id" IS NOT NULL;

ALTER TABLE "find_candidate_results" DROP CONSTRAINT IF EXISTS "find_candidate_results_target_kind_check";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "target_kind";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "target_key";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "source_uri";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "provider";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "model";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "raw_output";
ALTER TABLE "find_candidate_results" DROP COLUMN IF EXISTS "metadata";

ALTER TABLE "cover_evidence_results" DROP COLUMN IF EXISTS "tried_stages";
ALTER TABLE "cover_evidence_results" DROP COLUMN IF EXISTS "raw_output";
ALTER TABLE "cover_evidence_results" DROP COLUMN IF EXISTS "provider";
ALTER TABLE "cover_evidence_results" DROP COLUMN IF EXISTS "model";
ALTER TABLE "cover_evidence_results" DROP COLUMN IF EXISTS "metadata";

DROP INDEX IF EXISTS "distillation_read_events_content_hash_idx";
ALTER TABLE "distillation_read_events" DROP COLUMN IF EXISTS "content_hash";

UPDATE "knowledge_items"
SET "metadata" = "metadata" - 'contentHash'
WHERE "metadata" ? 'contentHash';
