ALTER TABLE "context_pack_items" DROP CONSTRAINT IF EXISTS "context_pack_items_section_check";
--> statement-breakpoint
ALTER TABLE "context_pack_items" ADD CONSTRAINT "context_pack_items_section_check" CHECK ("section" IN ('rules', 'procedures', 'code_context', 'warnings', 'guardrails'));
