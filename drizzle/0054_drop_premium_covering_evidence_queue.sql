DELETE FROM "distillation_queue_events"
WHERE "queue_name" = 'premiumCoveringEvidence'
   OR "event_type" = 'escalated_to_premium';

DELETE FROM "evidence_coverage_results"
WHERE "producer_queue" = 'premiumCoveringEvidence';

UPDATE "settings"
SET
  "value" = jsonb_set(
    "value",
    '{queues}',
    coalesce("value"->'queues', '{}'::jsonb) - 'premiumCoveringEvidence'
  ),
  "updated_at" = now()
WHERE "namespace" = 'runtime'
  AND "key" = 'queue.controls.v1'
  AND jsonb_typeof("value") = 'object';

ALTER TABLE "distillation_queue_migration_map"
  DROP CONSTRAINT IF EXISTS "distillation_queue_migration_map_premium_job_id_premium_covering_evidence_queue_id_fk";

ALTER TABLE "distillation_queue_migration_map"
  DROP COLUMN IF EXISTS "premium_job_id";

DROP TABLE IF EXISTS "premium_covering_evidence_queue";

ALTER TABLE "evidence_coverage_results"
  DROP CONSTRAINT IF EXISTS "evidence_coverage_results_producer_queue_check";

ALTER TABLE "evidence_coverage_results"
  ADD CONSTRAINT "evidence_coverage_results_producer_queue_check"
  CHECK ("producer_queue" IN ('coveringEvidence'));

ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_queue_name_check";

ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_queue_name_check"
  CHECK ("queue_name" IN ('findingCandidate', 'coveringEvidence', 'finalizeDistille'));

ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_event_type_check";

ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_event_type_check"
  CHECK ("event_type" IN (
    'claimed',
    'completed',
    'paused',
    'resumed',
    'retried',
    'reprocess_requested',
    'enqueued',
    'migration_mapped',
    'migration_failed'
  ));
