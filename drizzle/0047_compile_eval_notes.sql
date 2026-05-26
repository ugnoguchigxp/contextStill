ALTER TABLE "session_memos" ADD COLUMN "kind" text DEFAULT 'scratch' NOT NULL;
--> statement-breakpoint
ALTER TABLE "session_memo_events" ADD COLUMN "kind" text DEFAULT 'scratch' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_runs" ADD COLUMN "session_id" text;
--> statement-breakpoint
ALTER TABLE "session_memos" DROP CONSTRAINT "session_memos_body_length_check";
--> statement-breakpoint
ALTER TABLE "session_memos" ADD CONSTRAINT "session_memos_body_length_check" CHECK (char_length("session_memos"."body") <= 10000);
--> statement-breakpoint
ALTER TABLE "session_memos" ADD CONSTRAINT "session_memos_kind_length_check" CHECK (char_length("session_memos"."kind") <= 64);
--> statement-breakpoint
ALTER TABLE "session_memo_events" ADD CONSTRAINT "session_memo_events_kind_length_check" CHECK (char_length("session_memo_events"."kind") <= 64);
--> statement-breakpoint
CREATE INDEX "session_memos_session_kind_updated_at_idx" ON "session_memos" USING btree ("session_id","kind","updated_at") WHERE "session_memos"."deleted_at" is null;
--> statement-breakpoint
CREATE INDEX "session_memo_events_session_kind_created_at_idx" ON "session_memo_events" USING btree ("session_id","kind","created_at");
--> statement-breakpoint
CREATE INDEX "context_compile_runs_session_created_at_idx" ON "context_compile_runs" USING btree ("session_id","created_at") WHERE "context_compile_runs"."session_id" is not null;
