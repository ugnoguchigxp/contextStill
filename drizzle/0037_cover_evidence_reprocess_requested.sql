ALTER TABLE "cover_evidence_results"
  DROP CONSTRAINT IF EXISTS "cover_evidence_results_status_check";
--> statement-breakpoint
ALTER TABLE "cover_evidence_results"
  ADD CONSTRAINT "cover_evidence_results_status_check"
  CHECK ("status" IN ('knowledge_ready','duplicate','near_duplicate','insufficient','reprocess_requested','parse_failed','tool_failed','provider_failed'));
