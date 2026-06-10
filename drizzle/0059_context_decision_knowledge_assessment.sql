ALTER TABLE "context_decision_coverage_traces"
  DROP CONSTRAINT IF EXISTS "context_decision_coverage_query_role_check";
--> statement-breakpoint
ALTER TABLE "context_decision_coverage_traces"
  ADD CONSTRAINT "context_decision_coverage_query_role_check"
  CHECK ("context_decision_coverage_traces"."query_role" IN ('support', 'counter_evidence', 'user_preference', 'risk', 'verification', 'alternative'));
