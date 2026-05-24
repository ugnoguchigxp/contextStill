import { buildLandscapeReplayComparison } from "./landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "./landscape-replay.service.js";
import { buildLandscapeSnapshot } from "./landscape.service.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  countLandscapeReviewItemRows,
  findLandscapeReviewItemRowById,
  insertLandscapeReviewItemsIdempotent,
  listLandscapeReviewItemRows,
  updateLandscapeReviewItemRow,
  type LandscapeReviewItemRow,
} from "./landscape-review-items.repository.js";
import {
  landscapeReviewItemCandidateSchema,
  landscapeReviewItemSchema,
  landscapeReviewItemStatusSchema,
  type LandscapeReviewItem,
  type LandscapeReviewItemCandidate,
  type LandscapeReviewItemStatus,
} from "../../shared/schemas/landscape-review.schema.js";
import type {
  BuildLandscapeReviewItemCandidatesInput,
  LandscapeReviewItemCandidateBuildResult,
  LandscapeReviewItemListResult,
  LandscapeReviewItemMaterializeResult,
  MaterializeLandscapeReviewItemsInput,
  UpdateLandscapeReviewItemStatusInput,
  ListLandscapeReviewItemsInput,
} from "./landscape-review-items.types.js";

const MAX_EVIDENCE_COUNT = 8;
const MAX_GOAL_PREVIEW_LENGTH = 180;

const reasonOrder: Record<string, number> = {
  used_baseline_lost: 0,
  baseline_off_topic: 1,
  baseline_wrong: 2,
  baseline_missing_after_recompile: 3,
  negative_attractor_candidate: 4,
  wrong_review_required: 5,
  over_selected_not_used: 6,
  dead_zone_reachability_risk: 7,
  dead_zone_stale: 8,
  semantic_reachable_dead_zone: 9,
  semantic_split: 10,
  semantic_merge: 11,
  relation_orphan: 12,
  promotion_gate_review: 13,
};

const replayCompareReasonMapping: Record<
  | "used_baseline_lost"
  | "baseline_off_topic"
  | "baseline_wrong"
  | "baseline_missing_after_recompile",
  {
    proposedAction: LandscapeReviewItemCandidate["proposedAction"];
    priority: number;
  }
> = {
  used_baseline_lost: {
    proposedAction: "repair_reachability",
    priority: 80,
  },
  baseline_off_topic: {
    proposedAction: "refine_applies_to",
    priority: 75,
  },
  baseline_wrong: {
    proposedAction: "review_wrong",
    priority: 95,
  },
  baseline_missing_after_recompile: {
    proposedAction: "repair_reachability",
    priority: 65,
  },
};

const landscapeSnapshotReasonMapping: Record<
  | "negative_attractor_candidate"
  | "wrong_review_required"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale",
  {
    proposedAction: LandscapeReviewItemCandidate["proposedAction"];
    priority: number;
  }
> = {
  negative_attractor_candidate: {
    proposedAction: "refine_applies_to",
    priority: 85,
  },
  wrong_review_required: {
    proposedAction: "review_wrong",
    priority: 95,
  },
  over_selected_not_used: {
    proposedAction: "review_only",
    priority: 55,
  },
  dead_zone_reachability_risk: {
    proposedAction: "repair_reachability",
    priority: 70,
  },
  dead_zone_stale: {
    proposedAction: "review_only",
    priority: 45,
  },
};

const semanticRelationReasonMapping: Record<
  "semantic_reachable_dead_zone" | "semantic_split" | "semantic_merge" | "relation_orphan",
  {
    proposedAction: LandscapeReviewItemCandidate["proposedAction"];
    priority: number;
  }
> = {
  semantic_reachable_dead_zone: {
    proposedAction: "repair_reachability",
    priority: 75,
  },
  semantic_split: {
    proposedAction: "split_or_merge_review",
    priority: 55,
  },
  semantic_merge: {
    proposedAction: "split_or_merge_review",
    priority: 55,
  },
  relation_orphan: {
    proposedAction: "review_only",
    priority: 35,
  },
};

function isSemanticComparisonKind(
  value: string,
): value is
  | "semantic_reachable_dead_zone"
  | "semantic_split"
  | "semantic_merge"
  | "relation_orphan" {
  return (
    value === "semantic_reachable_dead_zone" ||
    value === "semantic_split" ||
    value === "semantic_merge" ||
    value === "relation_orphan"
  );
}

const allowedTransitions: Record<LandscapeReviewItemStatus, LandscapeReviewItemStatus[]> = {
  pending: ["reviewing", "resolved", "dismissed"],
  reviewing: ["pending", "resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

export class LandscapeReviewItemsError extends Error {
  readonly statusCode: 400 | 409;

  constructor(statusCode: 400 | 409, message: string) {
    super(message);
    this.name = "LandscapeReviewItemsError";
    this.statusCode = statusCode;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeFacetValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, trimmed);
  }
  return [...deduped.values()].sort((a, b) => a.localeCompare(b));
}

function normalizeSuggestedAppliesTo(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const normalized: Record<string, unknown> = {};
  const repoKey = typeof source.repoKey === "string" ? source.repoKey.trim() : "";
  const repoPath = typeof source.repoPath === "string" ? source.repoPath.trim() : "";
  const retrievalMode = typeof source.retrievalMode === "string" ? source.retrievalMode.trim() : "";

  if (repoKey) normalized.repoKey = repoKey;
  if (repoPath) normalized.repoPath = repoPath;
  if (retrievalMode) normalized.retrievalMode = retrievalMode;

  const technologies = normalizeFacetValues(source.technologies);
  const changeTypes = normalizeFacetValues(source.changeTypes);
  const domains = normalizeFacetValues(source.domains);
  if (technologies.length > 0) normalized.technologies = technologies;
  if (changeTypes.length > 0) normalized.changeTypes = changeTypes;
  if (domains.length > 0) normalized.domains = domains;

  return normalized;
}

function normalizeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
    if (deduped.size >= MAX_EVIDENCE_COUNT) break;
  }
  return [...deduped];
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIdempotencyKey(
  source: string,
  reason: string,
  runId: string,
  knowledgeId: string,
): string {
  const raw = `${source}:${reason}:${runId}:${knowledgeId}`.toLowerCase();
  return raw.replace(/[^a-z0-9:_-]/g, "_");
}

function clampPriority(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function mapReviewItemRow(row: LandscapeReviewItemRow): LandscapeReviewItem {
  return landscapeReviewItemSchema.parse({
    id: row.id,
    source: row.source,
    reason: row.reason,
    status: row.status,
    proposedAction: row.proposedAction,
    priority: row.priority,
    confidence: row.confidence,
    knowledgeId: row.knowledgeId ?? null,
    runId: row.runId ?? null,
    triggerEventId: row.triggerEventId ?? null,
    communityKey: row.communityKey ?? null,
    communityLabel: row.communityLabel ?? null,
    suggestedAppliesTo: asRecord(row.suggestedAppliesTo),
    evidence: normalizeEvidence(row.evidence),
    payload: asRecord(row.payload),
    note: row.note ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    resolvedAt: row.resolvedAt ? toIsoString(row.resolvedAt) : null,
  });
}

function buildReplayCompareCandidates(
  input: BuildLandscapeReviewItemCandidatesInput,
): LandscapeReviewItemCandidate[] {
  if (!input.sources.includes("replay_compare")) return [];

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return input.appliesToRefineCandidates
    .map((candidate) => {
      const mapping = replayCompareReasonMapping[candidate.reason];
      if (!mapping) return null;

      const runId = normalizeNullableString(candidate.runId);
      const knowledgeId = normalizeNullableString(candidate.knowledgeId);
      if (!runId || !knowledgeId) return null;

      const idempotencyKey = normalizeIdempotencyKey(
        "replay_compare",
        candidate.reason,
        runId,
        knowledgeId,
      );

      const goalPreview = "";
      return landscapeReviewItemCandidateSchema.parse({
        source: "replay_compare",
        reason: candidate.reason,
        proposedAction: mapping.proposedAction,
        priority: clampPriority(mapping.priority),
        confidence: candidate.confidence,
        idempotencyKey,
        knowledgeId,
        runId,
        triggerEventId: null,
        communityKey: null,
        communityLabel: null,
        suggestedAppliesTo: normalizeSuggestedAppliesTo(candidate.suggestedAppliesTo),
        evidence: normalizeEvidence(candidate.evidence),
        payload: {
          comparisonRun: runId,
          goalPreview: goalPreview.slice(0, MAX_GOAL_PREVIEW_LENGTH),
          generatedBy: "landscape_replay_compare",
          generatedAt,
          runStatus: input.runStatus,
        },
        note: null,
      });
    })
    .filter((candidate): candidate is LandscapeReviewItemCandidate => Boolean(candidate));
}

function buildLandscapeSnapshotCandidates(
  input: BuildLandscapeReviewItemCandidatesInput,
): LandscapeReviewItemCandidate[] {
  if (!input.sources.includes("landscape_snapshot")) return [];
  if (!input.landscapeSnapshot) return [];

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const communityByKey = new Map(
    input.landscapeSnapshot.communities.map(
      (community) => [community.communityKey, community] as const,
    ),
  );

  return input.landscapeSnapshot.risks
    .map((risk) => {
      const mapping = landscapeSnapshotReasonMapping[risk.type];
      if (!mapping) return null;

      const idempotencyKey = normalizeIdempotencyKey(
        "landscape_snapshot",
        risk.type,
        risk.communityKey,
        risk.communityKey,
      );
      const community = communityByKey.get(risk.communityKey);
      const representativeKnowledgeIds = (community?.representativeKnowledgeIds ?? []).slice(0, 10);
      const evidence = normalizeEvidence([
        risk.reason,
        ...(community?.recommendedActions ?? []),
        community?.classification.reason ?? "",
      ]);

      return landscapeReviewItemCandidateSchema.parse({
        source: "landscape_snapshot",
        reason: risk.type,
        proposedAction: mapping.proposedAction,
        priority: clampPriority(mapping.priority),
        confidence: risk.severity,
        idempotencyKey,
        knowledgeId: null,
        runId: null,
        triggerEventId: null,
        communityKey: risk.communityKey,
        communityLabel: risk.communityLabel,
        suggestedAppliesTo: {},
        evidence,
        payload: {
          generatedBy: "landscape_snapshot_risk",
          generatedAt,
          communityRank: risk.communityRank,
          representativeKnowledgeIds,
          classificationPrimary: community?.classification.primary ?? null,
          classificationConfidence: community?.classification.confidence ?? null,
          sourceRefDensity: community?.quality.sourceRefDensity ?? null,
          selectedItemCountWindow: community?.selection.selectedItemCountWindow ?? null,
          windowDays: input.landscapeSnapshot?.windowDays ?? null,
        },
        note: null,
      });
    })
    .filter((candidate): candidate is LandscapeReviewItemCandidate => Boolean(candidate));
}

function toSemanticComparisonConfidence(
  comparison:
    | "semantic_reachable_dead_zone"
    | "semantic_split"
    | "semantic_merge"
    | "relation_orphan",
  deadZoneSemanticReachabilityScore: number,
): LandscapeReviewItemCandidate["confidence"] {
  if (comparison !== "semantic_reachable_dead_zone") return "medium";
  if (deadZoneSemanticReachabilityScore >= 0.75) return "high";
  if (deadZoneSemanticReachabilityScore >= 0.4) return "medium";
  return "low";
}

function buildSemanticRelationComparisonCandidates(
  input: BuildLandscapeReviewItemCandidatesInput,
): LandscapeReviewItemCandidate[] {
  if (!input.sources.includes("semantic_relation_comparison")) return [];
  if (!input.landscapeReplaySnapshot) return [];

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return input.landscapeReplaySnapshot.communityComparison.communities
    .map((comparison) => {
      if (!isSemanticComparisonKind(comparison.comparison)) return null;
      const mapping = semanticRelationReasonMapping[comparison.comparison];
      if (!mapping) return null;

      const idempotencyKey = normalizeIdempotencyKey(
        "semantic_relation_comparison",
        comparison.comparison,
        comparison.relationCommunityKey,
        comparison.relationCommunityKey,
      );
      const evidence = normalizeEvidence([
        `comparison=${comparison.comparison}`,
        `jaccardOverlap=${comparison.jaccardOverlap.toFixed(3)}`,
        `selectedNeighborCountWindow=${comparison.selectedNeighborCountWindow}`,
        `deadZoneSemanticReachabilityScore=${comparison.deadZoneSemanticReachabilityScore.toFixed(3)}`,
      ]);
      const representativeKnowledgeIds = comparison.selectedNeighborKnowledgeIds.slice(0, 10);

      return landscapeReviewItemCandidateSchema.parse({
        source: "semantic_relation_comparison",
        reason: comparison.comparison,
        proposedAction: mapping.proposedAction,
        priority: clampPriority(mapping.priority),
        confidence: toSemanticComparisonConfidence(
          comparison.comparison,
          comparison.deadZoneSemanticReachabilityScore,
        ),
        idempotencyKey,
        knowledgeId: null,
        runId: null,
        triggerEventId: null,
        communityKey: comparison.relationCommunityKey,
        communityLabel: comparison.relationCommunityLabel,
        suggestedAppliesTo: {},
        evidence,
        payload: {
          generatedBy: "landscape_semantic_relation_comparison",
          generatedAt,
          relationCommunityRank: comparison.relationCommunityRank,
          semanticCommunityKey: comparison.semanticCommunityKey ?? null,
          jaccardOverlap: comparison.jaccardOverlap,
          relationCommunitySize: comparison.relationCommunitySize,
          semanticCommunitySize: comparison.semanticCommunitySize,
          selectedNeighborCountWindow: comparison.selectedNeighborCountWindow,
          deadZoneSemanticReachabilityScore: comparison.deadZoneSemanticReachabilityScore,
          representativeKnowledgeIds,
        },
        note: null,
      });
    })
    .filter((candidate): candidate is LandscapeReviewItemCandidate => Boolean(candidate));
}

function buildPromotionGateCandidates(
  input: BuildLandscapeReviewItemCandidatesInput,
): LandscapeReviewItemCandidate[] {
  if (!input.sources.includes("promotion_gate")) return [];
  if (!input.landscapeReplayComparison) return [];

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const summary = input.landscapeReplayComparison.promotionGateSummary;
  if (summary.gateMode !== "review_required") return [];

  const analysisDay = generatedAt.slice(0, 10);
  const idempotencyKey = normalizeIdempotencyKey(
    "promotion_gate",
    "promotion_gate_review",
    `${input.landscapeReplayComparison.windowDays}:${input.runStatus}:${input.landscapeReplayComparison.basis.currentLimit}:${analysisDay}`,
    "global",
  );

  return [
    landscapeReviewItemCandidateSchema.parse({
      source: "promotion_gate",
      reason: "promotion_gate_review",
      proposedAction: "promotion_gate_review",
      priority: 90,
      confidence: summary.shouldTighten ? "high" : summary.affectedRunCount > 0 ? "medium" : "low",
      idempotencyKey,
      knowledgeId: null,
      runId: null,
      triggerEventId: null,
      communityKey: null,
      communityLabel: null,
      suggestedAppliesTo: {},
      evidence: normalizeEvidence([
        summary.reason,
        `affectedRunCount=${summary.affectedRunCount}`,
        `riskyNewKnowledgeCount=${summary.riskyNewKnowledgeCount}`,
      ]),
      payload: {
        generatedBy: "landscape_promotion_gate",
        generatedAt,
        gateMode: summary.gateMode,
        shouldTighten: summary.shouldTighten,
        affectedRunCount: summary.affectedRunCount,
        riskyNewKnowledgeCount: summary.riskyNewKnowledgeCount,
        reason: summary.reason,
        runStatus: input.runStatus,
        windowDays: input.landscapeReplayComparison.windowDays,
        currentLimit: input.landscapeReplayComparison.basis.currentLimit,
        analysisDay,
      },
      note: null,
    }),
  ];
}

function sortCandidatesForMaterialize(candidates: LandscapeReviewItemCandidate[]) {
  return [...candidates].sort((left, right) => {
    const priorityDiff = right.priority - left.priority;
    if (priorityDiff !== 0) return priorityDiff;
    const leftOrder = reasonOrder[left.reason] ?? 999;
    const rightOrder = reasonOrder[right.reason] ?? 999;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.idempotencyKey.localeCompare(right.idempotencyKey);
  });
}

function uniqueCandidatesByIdempotencyKey(
  candidates: LandscapeReviewItemCandidate[],
): LandscapeReviewItemCandidate[] {
  const deduped = new Map<string, LandscapeReviewItemCandidate>();
  for (const candidate of candidates) {
    if (!deduped.has(candidate.idempotencyKey)) {
      deduped.set(candidate.idempotencyKey, candidate);
    }
  }
  return [...deduped.values()];
}

export async function buildLandscapeReviewItemCandidates(
  input: BuildLandscapeReviewItemCandidatesInput,
): Promise<LandscapeReviewItemCandidateBuildResult> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const replayCompareCandidates = buildReplayCompareCandidates({
    ...input,
    generatedAt,
  });
  const landscapeSnapshotCandidates = buildLandscapeSnapshotCandidates({
    ...input,
    generatedAt,
  });
  const semanticRelationComparisonCandidates = buildSemanticRelationComparisonCandidates({
    ...input,
    generatedAt,
  });
  const promotionGateCandidates = buildPromotionGateCandidates({
    ...input,
    generatedAt,
  });
  const candidates = sortCandidatesForMaterialize([
    ...replayCompareCandidates,
    ...landscapeSnapshotCandidates,
    ...semanticRelationComparisonCandidates,
    ...promotionGateCandidates,
  ]);

  return {
    generatedAt,
    candidates,
    candidateCount: candidates.length,
  };
}

export async function materializeLandscapeReviewItems(
  input: MaterializeLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemMaterializeResult> {
  const supportedSources = new Set<LandscapeReviewItemCandidate["source"]>([
    "replay_compare",
    "landscape_snapshot",
    "semantic_relation_comparison",
    "promotion_gate",
  ]);
  const unsupportedSources = input.sources.filter((source) => !supportedSources.has(source));
  if (unsupportedSources.length > 0) {
    throw new LandscapeReviewItemsError(
      400,
      `unsupported sources in current phase: ${unsupportedSources.join(", ")}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const [comparison, landscapeSnapshot, landscapeReplaySnapshot] = await Promise.all([
    input.sources.includes("replay_compare") || input.sources.includes("promotion_gate")
      ? buildLandscapeReplayComparison({
          windowDays: input.windowDays,
          limit: input.limit,
          runStatus: input.runStatus,
          currentLimit: input.currentLimit,
          includeRuns: false,
        })
      : Promise.resolve(null),
    input.sources.includes("landscape_snapshot")
      ? buildLandscapeSnapshot({
          windowDays: input.windowDays,
          limit: input.landscapeLimit,
          status: input.landscapeStatus,
          relationAxes: input.relationAxes,
          minSelectedCount: input.minSelectedCount,
          minFeedbackCount: input.minFeedbackCount,
        })
      : Promise.resolve(null),
    input.sources.includes("semantic_relation_comparison")
      ? buildLandscapeReplaySnapshot({
          windowDays: input.windowDays,
          limit: input.limit,
          landscapeLimit: input.landscapeLimit,
          runStatus: input.runStatus,
          landscapeStatus: input.landscapeStatus,
          relationAxes: input.relationAxes,
          minSelectedCount: input.minSelectedCount,
          minFeedbackCount: input.minFeedbackCount,
          minSimilarity: input.minSimilarity,
          semanticTopK: input.semanticTopK,
          includeRuns: false,
        })
      : Promise.resolve(null),
  ]);

  const candidateBuild = await buildLandscapeReviewItemCandidates({
    generatedAt,
    runStatus: input.runStatus,
    sources: input.sources,
    appliesToRefineCandidates: comparison?.appliesToRefineCandidates ?? [],
    landscapeSnapshot,
    landscapeReplaySnapshot,
    landscapeReplayComparison: comparison,
  });
  const prioritizedCandidates = sortCandidatesForMaterialize(
    uniqueCandidatesByIdempotencyKey(candidateBuild.candidates),
  );
  const materializeCandidates = prioritizedCandidates.slice(0, input.materializeLimit);
  const skippedCount = Math.max(0, prioritizedCandidates.length - materializeCandidates.length);

  if (input.dryRun) {
    return {
      dryRun: true,
      generatedAt: candidateBuild.generatedAt,
      candidateCount: prioritizedCandidates.length,
      insertedCount: 0,
      existingCount: 0,
      skippedCount,
      items: [],
      candidates: materializeCandidates,
    };
  }

  const { inserted, existing } = await insertLandscapeReviewItemsIdempotent(materializeCandidates);
  const rowByKey = new Map(
    [...inserted, ...existing].map((row) => [row.idempotencyKey, row] as const),
  );
  const items = materializeCandidates
    .map((candidate) => rowByKey.get(candidate.idempotencyKey))
    .filter((row): row is LandscapeReviewItemRow => Boolean(row))
    .map(mapReviewItemRow);

  await recordAuditLogSafe({
    eventType: auditEventTypes.landscapeReviewItemsMaterialized,
    actor: "agent",
    payload: {
      dryRun: false,
      candidateCount: prioritizedCandidates.length,
      insertedCount: inserted.length,
      existingCount: existing.length,
      skippedCount,
      sourceCount: input.sources.length,
      runStatus: input.runStatus,
      windowDays: input.windowDays,
    },
  });

  return {
    dryRun: false,
    generatedAt: candidateBuild.generatedAt,
    candidateCount: prioritizedCandidates.length,
    insertedCount: inserted.length,
    existingCount: existing.length,
    skippedCount,
    items,
    candidates: materializeCandidates,
  };
}

export async function listLandscapeReviewItems(
  input: ListLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemListResult> {
  const [rows, count] = await Promise.all([
    listLandscapeReviewItemRows(input),
    countLandscapeReviewItemRows(input),
  ]);
  const items = rows.map(mapReviewItemRow);
  return {
    items,
    count,
  };
}

export async function updateLandscapeReviewItemStatus(
  input: UpdateLandscapeReviewItemStatusInput,
): Promise<LandscapeReviewItem | null> {
  const row = await findLandscapeReviewItemRowById(input.id);
  if (!row) return null;

  const currentStatusParsed = landscapeReviewItemStatusSchema.safeParse(row.status);
  if (!currentStatusParsed.success) {
    throw new LandscapeReviewItemsError(409, `invalid current status: ${row.status}`);
  }
  const currentStatus = currentStatusParsed.data;

  if (input.status === currentStatus) {
    return mapReviewItemRow(row);
  }

  if (!allowedTransitions[currentStatus].includes(input.status)) {
    throw new LandscapeReviewItemsError(
      409,
      `invalid status transition: ${currentStatus} -> ${input.status}`,
    );
  }

  const now = new Date();
  const resolvedAt = input.status === "resolved" || input.status === "dismissed" ? now : null;
  const updated = await updateLandscapeReviewItemRow({
    id: input.id,
    status: input.status,
    note: input.note,
    resolvedAt,
    updatedAt: now,
  });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.landscapeReviewItemStatusChanged,
    actor: "agent",
    payload: {
      id: input.id,
      previousStatus: currentStatus,
      status: input.status,
      note: input.note ?? null,
    },
  });

  return mapReviewItemRow(updated);
}
