CREATE TABLE IF NOT EXISTS "knowledge_tag_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "sort_order" integer NOT NULL DEFAULT 1000,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_tag_definitions_kind_check"
    CHECK ("kind" IN ('technology', 'change_type', 'retrieval_mode', 'domain')),
  CONSTRAINT "knowledge_tag_definitions_status_check"
    CHECK ("status" IN ('active', 'draft', 'deprecated')),
  CONSTRAINT "knowledge_tag_definitions_kind_slug_unique"
    UNIQUE ("kind", "slug")
);

CREATE INDEX IF NOT EXISTS "knowledge_tag_definitions_kind_status_idx"
  ON "knowledge_tag_definitions" ("kind", "status");

CREATE INDEX IF NOT EXISTS "knowledge_tag_definitions_aliases_gin_idx"
  ON "knowledge_tag_definitions" USING gin ("aliases");

CREATE INDEX IF NOT EXISTS "knowledge_items_applies_to_gin_idx"
  ON "knowledge_items" USING gin ("applies_to" jsonb_path_ops);
