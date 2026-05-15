DELETE FROM context_pack_items
WHERE section = 'lessons'
  OR item_kind IN ('fact', 'lesson');

DELETE FROM relations
WHERE (
    source_kind IN ('knowledge', 'knowledge_item', 'knowledge_items')
    AND source_id IN (SELECT id::text FROM knowledge_items WHERE type IN ('fact', 'lesson'))
  )
  OR (
    target_kind IN ('knowledge', 'knowledge_item', 'knowledge_items')
    AND target_id IN (SELECT id::text FROM knowledge_items WHERE type IN ('fact', 'lesson'))
  );

DELETE FROM knowledge_items
WHERE type IN ('fact', 'lesson');

ALTER TABLE knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_type_check;

ALTER TABLE knowledge_items
  ADD CONSTRAINT knowledge_items_type_check
  CHECK ("type" IN ('rule','procedure'));

ALTER TABLE context_pack_items
  DROP CONSTRAINT IF EXISTS context_pack_items_section_check;

ALTER TABLE context_pack_items
  ADD CONSTRAINT context_pack_items_section_check
  CHECK ("section" IN ('rules','procedures','code_context','warnings'));
