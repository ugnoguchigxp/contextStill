DELETE FROM "episode_retrieval_feedback";--> statement-breakpoint
DELETE FROM "episode_refs";--> statement-breakpoint
DELETE FROM "episode_cards";--> statement-breakpoint
ALTER TABLE "episode_cards" ADD COLUMN "importance" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "episode_cards" ADD COLUMN "compile_use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "episode_cards" ADD COLUMN "decision_use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "episode_cards" ADD CONSTRAINT "episode_cards_importance_range_check" CHECK ("episode_cards"."importance" >= 0 and "episode_cards"."importance" <= 100);--> statement-breakpoint
ALTER TABLE "episode_cards" ADD CONSTRAINT "episode_cards_compile_use_count_range_check" CHECK ("episode_cards"."compile_use_count" >= 0);--> statement-breakpoint
ALTER TABLE "episode_cards" ADD CONSTRAINT "episode_cards_decision_use_count_range_check" CHECK ("episode_cards"."decision_use_count" >= 0);--> statement-breakpoint
DROP INDEX IF EXISTS "episode_cards_evidence_status_idx";--> statement-breakpoint
ALTER TABLE "episode_cards" DROP CONSTRAINT IF EXISTS "episode_cards_evidence_status_check";--> statement-breakpoint
ALTER TABLE "episode_cards" DROP COLUMN IF EXISTS "evidence_status";
