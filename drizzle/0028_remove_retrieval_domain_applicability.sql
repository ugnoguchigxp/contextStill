UPDATE "knowledge_items"
SET "applies_to" = (COALESCE("applies_to", '{}'::jsonb) - 'retrievalModes' - 'domains' - 'files');

DELETE FROM "knowledge_tag_definitions"
WHERE "kind" IN ('retrieval_mode', 'domain');
