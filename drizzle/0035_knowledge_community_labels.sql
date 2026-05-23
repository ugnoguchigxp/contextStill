CREATE TABLE IF NOT EXISTS "knowledge_community_labels" (
  "community_key" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "note" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_community_labels_updated_at_idx"
ON "knowledge_community_labels" USING btree ("updated_at");
