ALTER TABLE "distillation_target_states"
  DROP CONSTRAINT IF EXISTS "distillation_target_states_target_kind_check";

ALTER TABLE "distillation_target_states"
  ADD CONSTRAINT "distillation_target_states_target_kind_check"
  CHECK ("target_kind" IN ('wiki_file', 'vibe_memory', 'knowledge_candidate', 'web_ingest'));

ALTER TABLE "distillation_target_states"
  DROP CONSTRAINT IF EXISTS "distillation_target_states_phase_check";

ALTER TABLE "distillation_target_states"
  ADD CONSTRAINT "distillation_target_states_phase_check"
  CHECK (
    "phase" IN (
      'selected',
      'reading',
      'researching_source',
      'writing_source',
      'finding_candidate',
      'covering_evidence',
      'finalizing',
      'stored'
    )
  );

ALTER TABLE "distillation_target_states"
  DROP CONSTRAINT IF EXISTS "distillation_target_states_priority_group_check";

ALTER TABLE "distillation_target_states"
  ADD CONSTRAINT "distillation_target_states_priority_group_check"
  CHECK ("priority_group" IN ('knowledge_candidate', 'web_ingest', 'wiki', 'vibe_memory'));
