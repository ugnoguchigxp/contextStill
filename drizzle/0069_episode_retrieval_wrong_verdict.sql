ALTER TABLE "episode_retrieval_feedback" DROP CONSTRAINT IF EXISTS "episode_retrieval_feedback_verdict_check";
--> statement-breakpoint
ALTER TABLE "episode_retrieval_feedback" ADD CONSTRAINT "episode_retrieval_feedback_verdict_check" CHECK ("episode_retrieval_feedback"."verdict" IN ('used', 'not_relevant', 'wrong', 'needs_raw_check', 'stale'));
