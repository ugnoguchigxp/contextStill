ALTER TABLE IF EXISTS "knowledge_items"
  DROP CONSTRAINT IF EXISTS "knowledge_items_type_check";
ALTER TABLE IF EXISTS "knowledge_items"
  ADD CONSTRAINT "knowledge_items_type_check"
  CHECK ("type" IN ('fact','rule','procedure','lesson'));

ALTER TABLE IF EXISTS "knowledge_items"
  DROP CONSTRAINT IF EXISTS "knowledge_items_status_check";
ALTER TABLE IF EXISTS "knowledge_items"
  ADD CONSTRAINT "knowledge_items_status_check"
  CHECK ("status" IN ('draft','active','deprecated'));

ALTER TABLE IF EXISTS "knowledge_items"
  DROP CONSTRAINT IF EXISTS "knowledge_items_scope_check";
ALTER TABLE IF EXISTS "knowledge_items"
  ADD CONSTRAINT "knowledge_items_scope_check"
  CHECK ("scope" IN ('repo','global'));

ALTER TABLE IF EXISTS "sources"
  DROP CONSTRAINT IF EXISTS "sources_source_kind_check";
ALTER TABLE IF EXISTS "sources"
  ADD CONSTRAINT "sources_source_kind_check"
  CHECK ("source_kind" IN ('wiki'));

ALTER TABLE IF EXISTS "context_pack_items"
  DROP CONSTRAINT IF EXISTS "context_pack_items_section_check";
ALTER TABLE IF EXISTS "context_pack_items"
  ADD CONSTRAINT "context_pack_items_section_check"
  CHECK ("section" IN ('rules','procedures','lessons','code_context','warnings'));
