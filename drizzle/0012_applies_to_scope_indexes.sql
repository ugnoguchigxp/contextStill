UPDATE "knowledge_items"
SET "applies_to" = "applies_to" || jsonb_strip_nulls(
  jsonb_build_object(
    'repoPath', "metadata" ->> 'repoPath',
    'repoKey', "metadata" ->> 'repoKey'
  )
)
WHERE (("metadata" ? 'repoPath') OR ("metadata" ? 'repoKey'))
  AND (
    coalesce("applies_to" ->> 'repoPath', '') = ''
    OR coalesce("applies_to" ->> 'repoKey', '') = ''
  );

CREATE INDEX IF NOT EXISTS "knowledge_items_applies_to_repo_key_idx"
  ON "knowledge_items" (("applies_to" ->> 'repoKey'));

CREATE INDEX IF NOT EXISTS "knowledge_items_applies_to_repo_path_idx"
  ON "knowledge_items" (("applies_to" ->> 'repoPath'));
