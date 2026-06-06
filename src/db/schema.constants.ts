export const knowledgeTypeValues = ["rule", "procedure"] as const;
export const knowledgeStatusValues = ["draft", "active", "deprecated"] as const;
export const scopeValues = ["repo", "global"] as const;

export const knowledgeTagKindValues = [
  "technology",
  "change_type",
  "retrieval_mode",
  "domain",
] as const;
export const knowledgeTagStatusValues = ["active", "draft", "deprecated"] as const;

export const sourceKindValues = ["wiki"] as const;
export const settingValueKindValues = ["json", "string", "secret_ref", "encrypted"] as const;

export const distillationTargetKindValues = [
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
  "web_ingest",
] as const;
export const distillationQueueNameValues = [
  "findingCandidate",
  "coveringEvidence",
  "deadZoneMergeReview",
  "finalizeDistille",
  "mergeActivationFinalize",
] as const;
export const distillationQueueStatusValues = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "paused",
] as const;
export const distillationQueueInputKindValues = ["source_target", "provided_candidate"] as const;
export const distillationQueueSourceKindValues = [
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
  "web_ingest",
] as const;
export const distillationQueueProducerValues = ["coveringEvidence"] as const;
export const distillationQueueProviderPolicyValues = ["default", "cloud_api"] as const;
export const evidenceCoverageStatusValues = [
  "knowledge_ready",
  "duplicate",
  "near_duplicate",
  "insufficient",
  "parse_failed",
  "tool_failed",
  "provider_failed",
] as const;
export const distillationQueueEventTypeValues = [
  "claimed",
  "completed",
  "paused",
  "resumed",
  "retried",
  "reprocess_requested",
  "enqueued",
  "migration_mapped",
  "migration_failed",
] as const;
export const distillationQueueMigrationStatusValues = ["migrated", "skipped", "failed"] as const;
export const distillationTargetStatusValues = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "paused",
] as const;
export const distillationTargetPhaseValues = [
  "selected",
  "reading",
  "researching_source",
  "writing_source",
  "finding_candidate",
  "covering_evidence",
  "finalizing",
  "stored",
] as const;
export const distillationTargetPriorityGroupValues = [
  "knowledge_candidate",
  "web_ingest",
  "wiki",
  "vibe_memory",
] as const;

export const findCandidateResultStatusValues = ["selected", "parse_failed"] as const;

export const coverEvidenceStatusValues = [
  "knowledge_ready",
  "duplicate",
  "near_duplicate",
  "insufficient",
  "reprocess_requested",
  "parse_failed",
  "tool_failed",
  "provider_failed",
] as const;
export const coverEvidenceStageValues = [
  "load",
  "source_support",
  "dedupe",
  "evidence_need",
  "web",
  "mcp",
  "final",
] as const;

export const sourceLinkTypeValues = ["derived_from"] as const;

export const runStatusValues = ["ok", "degraded", "failed"] as const;
export const compileRunSourceValues = ["ui", "mcp", "cli", "unknown"] as const;
export const compileEvalOutcomeValues = ["useful", "partial", "misleading", "unused"] as const;

export const packSectionValues = ["rules", "procedures", "code_context", "warnings"] as const;
export const contextCompileCandidateTraceAgenticDecisionValues = [
  "not_evaluated",
  "accepted",
  "rejected",
  "skipped",
] as const;
export const contextCompileTaskTraceEmbeddingStatusValues = [
  "facets_only",
  "embedding_available",
  "embedding_unavailable",
] as const;

export const knowledgeUsageVerdictValues = ["used", "not_used", "off_topic", "wrong"] as const;
export const knowledgeReviewQueueStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;
export const knowledgeReviewProposedActionValues = [
  "review_only",
  "demote_to_draft_candidate",
] as const;

export const landscapeReviewItemSourceValues = [
  "replay_compare",
  "landscape_snapshot",
  "semantic_relation_comparison",
  "promotion_gate",
  "contradiction_detection",
] as const;
export const landscapeReviewItemReasonValues = [
  "used_baseline_lost",
  "baseline_off_topic",
  "baseline_wrong",
  "baseline_missing_after_recompile",
  "negative_attractor_candidate",
  "wrong_review_required",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
  "semantic_reachable_dead_zone",
  "semantic_split",
  "semantic_merge",
  "relation_orphan",
  "promotion_gate_review",
  "contradiction_review",
] as const;
export const landscapeReviewItemStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;
export const landscapeReviewItemProposedActionValues = [
  "review_only",
  "refine_applies_to",
  "repair_reachability",
  "review_wrong",
  "split_or_merge_review",
  "promotion_gate_review",
  "demote_to_draft_candidate",
  "review_contradiction",
] as const;
export const landscapeReviewItemConfidenceValues = ["low", "medium", "high"] as const;
export const landscapeReviewItemCandidateLinkStatusValues = [
  "draft_created",
  "review_required",
  "approved",
  "rejected",
  "finalized",
] as const;
export const landscapeSnapshotCacheTypeValues = [
  "landscape_snapshot",
  "landscape_replay_snapshot",
  "landscape_replay_comparison",
] as const;
export const landscapeSnapshotCacheStatusValues = ["ready", "stale"] as const;

export const knowledgeQualityAdjustmentKindValues = ["off_topic_quality_decrement"] as const;
export const auditLogActorValues = ["agent", "user", "system"] as const;
