ALTER TABLE "session_memos" DROP CONSTRAINT "session_memos_slot_range_check";
--> statement-breakpoint
ALTER TABLE "session_memos" ADD CONSTRAINT "session_memos_slot_range_check" CHECK ("session_memos"."slot" >= 0 and "session_memos"."slot" < 40);
