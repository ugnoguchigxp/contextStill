UPDATE "episode_cards"
SET "status" = 'active'
WHERE "status" = 'draft';--> statement-breakpoint
ALTER TABLE "episode_cards" DROP CONSTRAINT IF EXISTS "episode_cards_status_check";--> statement-breakpoint
ALTER TABLE "episode_cards" ADD CONSTRAINT "episode_cards_status_check" CHECK ("episode_cards"."status" IN ('active', 'deprecated'));
