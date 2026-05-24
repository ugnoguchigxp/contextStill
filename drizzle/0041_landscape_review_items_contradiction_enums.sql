ALTER TABLE "landscape_review_items"
  DROP CONSTRAINT IF EXISTS "landscape_review_items_source_check";
--> statement-breakpoint
ALTER TABLE "landscape_review_items"
  ADD CONSTRAINT "landscape_review_items_source_check"
  CHECK ("source" IN (
    'replay_compare',
    'landscape_snapshot',
    'semantic_relation_comparison',
    'promotion_gate',
    'contradiction_detection'
  ));
--> statement-breakpoint
ALTER TABLE "landscape_review_items"
  DROP CONSTRAINT IF EXISTS "landscape_review_items_reason_check";
--> statement-breakpoint
ALTER TABLE "landscape_review_items"
  ADD CONSTRAINT "landscape_review_items_reason_check"
  CHECK ("reason" IN (
    'used_baseline_lost',
    'baseline_off_topic',
    'baseline_wrong',
    'baseline_missing_after_recompile',
    'negative_attractor_candidate',
    'wrong_review_required',
    'over_selected_not_used',
    'dead_zone_reachability_risk',
    'dead_zone_stale',
    'semantic_reachable_dead_zone',
    'semantic_split',
    'semantic_merge',
    'relation_orphan',
    'promotion_gate_review',
    'contradiction_review'
  ));
--> statement-breakpoint
ALTER TABLE "landscape_review_items"
  DROP CONSTRAINT IF EXISTS "landscape_review_items_proposed_action_check";
--> statement-breakpoint
ALTER TABLE "landscape_review_items"
  ADD CONSTRAINT "landscape_review_items_proposed_action_check"
  CHECK ("proposed_action" IN (
    'review_only',
    'refine_applies_to',
    'repair_reachability',
    'review_wrong',
    'split_or_merge_review',
    'promotion_gate_review',
    'demote_to_draft_candidate',
    'review_contradiction'
  ));
