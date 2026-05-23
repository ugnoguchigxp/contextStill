ALTER TABLE "knowledge_usage_events"
  DROP CONSTRAINT IF EXISTS "knowledge_usage_events_verdict_check";

ALTER TABLE "knowledge_usage_events"
  ADD CONSTRAINT "knowledge_usage_events_verdict_check"
    CHECK ("verdict" IN ('used', 'not_used', 'off_topic', 'wrong'));

ALTER TABLE "knowledge_review_queue"
  DROP CONSTRAINT IF EXISTS "knowledge_review_queue_trigger_verdict_check";

ALTER TABLE "knowledge_review_queue"
  ADD CONSTRAINT "knowledge_review_queue_trigger_verdict_check"
    CHECK ("trigger_verdict" IN ('used', 'not_used', 'off_topic', 'wrong'));
