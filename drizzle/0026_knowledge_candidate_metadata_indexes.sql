CREATE INDEX IF NOT EXISTS "knowledge_items_cover_evidence_result_id_idx"
  ON "knowledge_items" ((metadata ->> 'coverEvidenceResultId'));

CREATE INDEX IF NOT EXISTS "knowledge_items_metadata_source_uri_idx"
  ON "knowledge_items" ((metadata ->> 'sourceUri'));
