CREATE TABLE "knowledge_origin_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"origin_kind" text NOT NULL,
	"origin_uri" text NOT NULL,
	"origin_key" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_origin_links_origin_kind_check" CHECK ("knowledge_origin_links"."origin_kind" IN ('vibe_memory', 'agent_candidate', 'landscape_review_item'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_origin_links" ADD CONSTRAINT "knowledge_origin_links_knowledge_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_origin_links_knowledge_id_idx" ON "knowledge_origin_links" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "knowledge_origin_links_origin_kind_idx" ON "knowledge_origin_links" USING btree ("origin_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_origin_links_knowledge_kind_uri_unique" ON "knowledge_origin_links" USING btree ("knowledge_id","origin_kind","origin_uri");