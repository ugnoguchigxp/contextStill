ALTER TABLE "knowledge_items" ADD COLUMN "polarity" text DEFAULT 'positive' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "intent_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_polarity_check" CHECK ("polarity" IN ('positive', 'negative', 'neutral'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_polarity_idx" ON "knowledge_items" USING btree ("polarity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_intent_tags_gin_idx" ON "knowledge_items" USING gin ("intent_tags");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_status_polarity_idx" ON "knowledge_items" USING btree ("status", "polarity");
--> statement-breakpoint
ALTER TABLE "knowledge_origin_links" DROP CONSTRAINT IF EXISTS "knowledge_origin_links_origin_kind_check";
--> statement-breakpoint
ALTER TABLE "knowledge_origin_links" ADD CONSTRAINT "knowledge_origin_links_origin_kind_check" CHECK ("origin_kind" IN ('vibe_memory', 'agent_candidate', 'landscape_review_item', 'review_finding', 'external_review_run', 'review_correction'));
--> statement-breakpoint
ALTER TABLE "knowledge_tag_definitions" DROP CONSTRAINT IF EXISTS "knowledge_tag_definitions_kind_check";
--> statement-breakpoint
ALTER TABLE "knowledge_tag_definitions" ADD CONSTRAINT "knowledge_tag_definitions_kind_check" CHECK ("kind" IN ('technology', 'change_type', 'retrieval_mode', 'domain', 'intent'));