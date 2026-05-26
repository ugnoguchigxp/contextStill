CREATE TABLE "session_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"slot" integer NOT NULL,
	"label" text,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'mcp' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "session_memos_slot_range_check" CHECK ("session_memos"."slot" >= 0 and "session_memos"."slot" < 20),
	CONSTRAINT "session_memos_source_check" CHECK ("session_memos"."source" in ('mcp', 'ui', 'system', 'import')),
	CONSTRAINT "session_memos_body_length_check" CHECK (char_length("session_memos"."body") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "session_memo_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"slot" integer,
	"label" text,
	"action" text NOT NULL,
	"body_preview" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'mcp' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_memo_events_action_check" CHECK ("session_memo_events"."action" in ('put', 'delete', 'clear', 'expire')),
	CONSTRAINT "session_memo_events_source_check" CHECK ("session_memo_events"."source" in ('mcp', 'ui', 'system', 'import'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_memos_active_slot_unique" ON "session_memos" USING btree ("session_id","slot") WHERE "session_memos"."deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "session_memos_active_label_unique" ON "session_memos" USING btree ("session_id",lower("label")) WHERE "session_memos"."deleted_at" is null and "session_memos"."label" is not null;
--> statement-breakpoint
CREATE INDEX "session_memos_session_updated_at_idx" ON "session_memos" USING btree ("session_id","updated_at");
--> statement-breakpoint
CREATE INDEX "session_memos_expires_at_idx" ON "session_memos" USING btree ("expires_at") WHERE "session_memos"."deleted_at" is null and "session_memos"."expires_at" is not null;
--> statement-breakpoint
CREATE INDEX "session_memo_events_session_created_at_idx" ON "session_memo_events" USING btree ("session_id","created_at");
