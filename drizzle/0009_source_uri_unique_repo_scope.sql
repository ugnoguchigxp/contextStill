WITH ranked_sources AS (
  SELECT
    id,
    uri,
    row_number() OVER (
      PARTITION BY uri
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY uri
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS keep_id
  FROM sources
),
source_mapping AS (
  SELECT id AS drop_id, keep_id
  FROM ranked_sources
  WHERE rn > 1
)
UPDATE source_fragments sf
SET source_id = sm.keep_id
FROM source_mapping sm
WHERE sf.source_id = sm.drop_id
  AND EXISTS (
    SELECT 1
    FROM knowledge_source_links ksl
    WHERE ksl.source_fragment_id = sf.id
  );

WITH ranked_sources AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY uri
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM sources
)
DELETE FROM sources
USING ranked_sources
WHERE sources.id = ranked_sources.id
  AND ranked_sources.rn > 1;

DROP INDEX IF EXISTS "sources_uri_hash_idx";
DROP INDEX IF EXISTS "sources_uri_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "sources_uri_unique_idx" ON "sources" ("uri");
CREATE INDEX IF NOT EXISTS "sources_content_hash_idx" ON "sources" ("content_hash");

UPDATE "knowledge_items"
SET "applies_to" = "applies_to" || jsonb_strip_nulls(
  jsonb_build_object(
    'repoPath', "metadata" ->> 'repoPath',
    'repoKey', "metadata" ->> 'repoKey'
  )
)
WHERE ("metadata" ? 'repoPath') OR ("metadata" ? 'repoKey');
