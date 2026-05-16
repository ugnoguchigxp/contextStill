ALTER TABLE "knowledge_items"
ADD COLUMN IF NOT EXISTS "compile_select_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "knowledge_items"
ADD COLUMN IF NOT EXISTS "last_compiled_at" timestamp;

ALTER TABLE "knowledge_items"
ADD COLUMN IF NOT EXISTS "agentic_accept_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "knowledge_items"
ADD COLUMN IF NOT EXISTS "explicit_upvote_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "knowledge_items"
ADD COLUMN IF NOT EXISTS "explicit_downvote_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "knowledge_items"
ADD COLUMN IF NOT EXISTS "dynamic_score" real NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "knowledge_items_last_compiled_at_idx"
  ON "knowledge_items" ("last_compiled_at");

CREATE INDEX IF NOT EXISTS "knowledge_items_dynamic_score_idx"
  ON "knowledge_items" ("dynamic_score");
