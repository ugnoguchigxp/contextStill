CREATE TABLE "episode_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "situation" text NOT NULL,
  "observations" text DEFAULT '' NOT NULL,
  "action" text DEFAULT '' NOT NULL,
  "outcome" text DEFAULT '' NOT NULL,
  "lesson" text DEFAULT '' NOT NULL,
  "applicability" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "anti_applicability" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "technologies" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "change_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "repo_path" text,
  "repo_key" text,
  "source_kind" text NOT NULL,
  "source_key" text NOT NULL,
  "outcome_kind" text DEFAULT 'unknown' NOT NULL,
  "confidence" integer DEFAULT 50 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "stale_at" timestamp,
  "embedding" vector(384),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "episode_cards_status_check" CHECK ("episode_cards"."status" IN ('active', 'deprecated')),
  CONSTRAINT "episode_cards_outcome_kind_check" CHECK ("episode_cards"."outcome_kind" IN ('success', 'failure', 'mixed', 'unknown')),
  CONSTRAINT "episode_cards_source_kind_check" CHECK ("episode_cards"."source_kind" IN ('vibe_memory', 'compile_run', 'decision_run', 'audit_log', 'manual')),
  CONSTRAINT "episode_cards_confidence_range_check" CHECK ("episode_cards"."confidence" >= 0 and "episode_cards"."confidence" <= 100),
  CONSTRAINT "episode_cards_applicability_object_check" CHECK (jsonb_typeof("episode_cards"."applicability") = 'object'),
  CONSTRAINT "episode_cards_anti_applicability_object_check" CHECK (jsonb_typeof("episode_cards"."anti_applicability") = 'object'),
  CONSTRAINT "episode_cards_domains_array_check" CHECK (jsonb_typeof("episode_cards"."domains") = 'array'),
  CONSTRAINT "episode_cards_technologies_array_check" CHECK (jsonb_typeof("episode_cards"."technologies") = 'array'),
  CONSTRAINT "episode_cards_change_types_array_check" CHECK (jsonb_typeof("episode_cards"."change_types") = 'array'),
  CONSTRAINT "episode_cards_tools_array_check" CHECK (jsonb_typeof("episode_cards"."tools") = 'array')
);
--> statement-breakpoint
CREATE TABLE "episode_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_card_id" uuid NOT NULL,
  "ref_kind" text NOT NULL,
  "ref_value" text NOT NULL,
  "locator" text,
  "query_hint" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "episode_refs_ref_kind_check" CHECK ("episode_refs"."ref_kind" IN ('vibe_memory', 'agent_diff', 'compile_run', 'decision_run', 'audit_log', 'file', 'commit'))
);
--> statement-breakpoint
CREATE TABLE "episode_retrieval_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_card_id" uuid NOT NULL,
  "run_kind" text NOT NULL,
  "run_id" text NOT NULL,
  "used_for" text NOT NULL,
  "verdict" text NOT NULL,
  "reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "episode_retrieval_feedback_run_kind_check" CHECK ("episode_retrieval_feedback"."run_kind" IN ('compile', 'decision', 'mcp', 'api')),
  CONSTRAINT "episode_retrieval_feedback_used_for_check" CHECK ("episode_retrieval_feedback"."used_for" IN ('compile', 'decision', 'search', 'drill_down')),
  CONSTRAINT "episode_retrieval_feedback_verdict_check" CHECK ("episode_retrieval_feedback"."verdict" IN ('used', 'not_relevant', 'needs_raw_check', 'stale'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "episode_cards_source_unique_idx" ON "episode_cards" USING btree ("source_kind","source_key");
--> statement-breakpoint
CREATE INDEX "episode_cards_status_idx" ON "episode_cards" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "episode_cards_repo_key_idx" ON "episode_cards" USING btree ("repo_key");
--> statement-breakpoint
CREATE INDEX "episode_cards_repo_path_idx" ON "episode_cards" USING btree ("repo_path");
--> statement-breakpoint
CREATE INDEX "episode_cards_outcome_kind_idx" ON "episode_cards" USING btree ("outcome_kind");
--> statement-breakpoint
CREATE INDEX "episode_cards_created_at_idx" ON "episode_cards" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "episode_cards_text_fts_idx" ON "episode_cards" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("situation", '') || ' ' || coalesce("observations", '') || ' ' || coalesce("action", '') || ' ' || coalesce("outcome", '') || ' ' || coalesce("lesson", '')));
--> statement-breakpoint
CREATE INDEX "episode_cards_embedding_hnsw_idx" ON "episode_cards" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
ALTER TABLE "episode_refs"
  ADD CONSTRAINT "episode_refs_episode_card_id_episode_cards_id_fk"
  FOREIGN KEY ("episode_card_id") REFERENCES "public"."episode_cards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "episode_retrieval_feedback"
  ADD CONSTRAINT "episode_retrieval_feedback_episode_card_id_episode_cards_id_fk"
  FOREIGN KEY ("episode_card_id") REFERENCES "public"."episode_cards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "episode_refs_episode_card_id_idx" ON "episode_refs" USING btree ("episode_card_id");
--> statement-breakpoint
CREATE INDEX "episode_refs_kind_value_idx" ON "episode_refs" USING btree ("ref_kind","ref_value");
--> statement-breakpoint
CREATE INDEX "episode_retrieval_feedback_episode_run_idx" ON "episode_retrieval_feedback" USING btree ("episode_card_id","run_kind","run_id");
--> statement-breakpoint
CREATE INDEX "episode_retrieval_feedback_verdict_created_at_idx" ON "episode_retrieval_feedback" USING btree ("verdict","created_at");
--> statement-breakpoint
ALTER TABLE "knowledge_origin_links"
  DROP CONSTRAINT IF EXISTS "knowledge_origin_links_origin_kind_check";
--> statement-breakpoint
ALTER TABLE "knowledge_origin_links"
  ADD CONSTRAINT "knowledge_origin_links_origin_kind_check"
  CHECK ("knowledge_origin_links"."origin_kind" IN ('vibe_memory', 'episode_card', 'agent_candidate', 'landscape_review_item', 'review_finding', 'external_review_run', 'review_correction'));
