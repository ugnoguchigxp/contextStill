UPDATE "knowledge_items"
SET "importance" = ROUND("importance" * 100)
WHERE "importance" >= 0
  AND "importance" <= 1;

UPDATE "knowledge_items"
SET "confidence" = ROUND("confidence" * 100)
WHERE "confidence" >= 0
  AND "confidence" <= 1;

ALTER TABLE "knowledge_items"
  ALTER COLUMN "importance" SET DEFAULT 70;

ALTER TABLE "knowledge_items"
  ALTER COLUMN "confidence" SET DEFAULT 70;
