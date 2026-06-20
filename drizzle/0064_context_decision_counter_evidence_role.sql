ALTER TABLE "context_decision_evidence"
  DROP CONSTRAINT IF EXISTS "context_decision_evidence_role_check";
--> statement-breakpoint
ALTER TABLE "context_decision_evidence"
  ADD CONSTRAINT "context_decision_evidence_role_check"
  CHECK ("context_decision_evidence"."role" IN ('selected_support', 'counter_evidence', 'rejected_alternative', 'user_preference', 'risk_warning', 'missing_counter_evidence'));
