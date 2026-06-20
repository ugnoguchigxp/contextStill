import { inArray } from "drizzle-orm";
import { buildGraphSnapshot } from "../../../api/modules/graph/graph.repository.js";
import { updateKnowledgeItem } from "../../../api/modules/knowledge/knowledge.repository.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import {
  type DeadZoneKnowledgeMaintenanceInput,
  type DeadZoneKnowledgeMaintenanceResult,
  type DeadZoneKnowledgeReviewActionInput,
  type DeadZoneKnowledgeReviewActionResult,
  type DeadZoneKnowledgeReviewBadge,
  type DeadZoneKnowledgeReviewItem,
  type DeadZoneKnowledgeReviewQuery,
  type DeadZoneKnowledgeReviewResponse,
  type DeadZoneRecommendationAction,
  deadZoneKnowledgeReviewQuerySchema,
  deadZoneKnowledgeReviewResponseSchema,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";
import { listLatestDeadZoneMergeReviewJobsByDeadZoneIds } from "./deadzone-merge-review-queue.repository.js";
import {
  type DeadZoneKnowledgeRow,
  listDeadZoneKnowledgeEvidenceRows,
  listDeadZoneKnowledgeRows,
  listDeadZoneReviewItemLinks,
  listSimilarKnowledgeRows,
  recordDeadZoneReviewDecision,
} from "./landscape-deadzone-review.repository.js";
import {
  type DeadZoneScoringKnowledge,
  deriveDeadZoneReviewBadges,
  scoreApplicabilityMatch,
  scoreDeadZoneRisk,
  scoreEvidenceStrength,
  scoreGraphHealth,
  scoreStructureQuality,
  scoreUsageStrength,
  suggestedActionForSimilar,
} from "./landscape-deadzone-review.scoring.js";
import { buildLandscapeSnapshot } from "./landscape.service.js";
import type { LandscapeCommunity } from "./landscape.types.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function loadKnowledgeTitleStatusRows(
  ids: string[],
): Promise<Array<{ id: string; title: string; status: string }>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    return sqlite.db
      .query<{ id: string; title: string; status: string }, string[]>(
        `select id, title, status from knowledge_items where id in (${placeholders})`,
      )
      .all(...uniqueIds);
  }
  return db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      status: knowledgeItems.status,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, uniqueIds));
}

async function loadKnowledgeMaintenanceRows(
  ids: string[],
): Promise<Array<{ id: string; title: string; body: string; status: string }>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    return sqlite.db
      .query<{ id: string; title: string; body: string; status: string }, string[]>(
        `select id, title, body, status from knowledge_items where id in (${placeholders})`,
      )
      .all(...uniqueIds);
  }
  return db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      status: knowledgeItems.status,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, uniqueIds));
}

function preview(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function asKnowledgeId(nodeId: string): string {
  return nodeId.replace(/^knowledge:/, "");
}

function isDeadZoneCommunity(community: LandscapeCommunity): boolean {
  return (
    community.classification.primary === "dead_zone_reachability_risk" ||
    community.classification.primary === "dead_zone_stale"
  );
}

function sortCandidateRows(left: DeadZoneKnowledgeRow, right: DeadZoneKnowledgeRow): number {
  return (
    left.compileSelectCount - right.compileSelectCount ||
    Number(left.lastCompiledAt !== null) - Number(right.lastCompiledAt !== null) ||
    left.importance - right.importance ||
    left.title.localeCompare(right.title)
  );
}

function toScoringKnowledge(input: {
  row: DeadZoneKnowledgeRow;
  sourceRefCount: number;
  originRefCount: number;
  sourceRefDensity: number;
}): DeadZoneScoringKnowledge {
  return {
    id: input.row.id,
    type: input.row.type,
    status: input.row.status,
    body: input.row.body,
    appliesTo: input.row.appliesTo,
    metadata: input.row.metadata,
    compileSelectCount: input.row.compileSelectCount,
    lastCompiledAt: input.row.lastCompiledAt,
    sourceRefCount: input.sourceRefCount,
    originRefCount: input.originRefCount,
    sourceRefDensity: input.sourceRefDensity,
    embedded: input.row.embedded,
  };
}

function knowledgeSummary(input: {
  row: DeadZoneKnowledgeRow;
  sourceRefCount: number;
  sourceRefDensity: number;
  community: LandscapeCommunity;
}): DeadZoneKnowledgeReviewItem["knowledge"] {
  return {
    id: input.row.id,
    title: input.row.title,
    bodyPreview: preview(input.row.body),
    type: input.row.type,
    status: input.row.status,
    appliesTo: input.row.appliesTo,
    confidence: input.row.confidence,
    importance: input.row.importance,
    compileSelectCount: input.row.compileSelectCount,
    lastCompiledAt: toIso(input.row.lastCompiledAt),
    sourceRefCount: input.sourceRefCount,
    sourceRefDensity: input.sourceRefDensity,
    communityKey: input.community.communityKey,
    communityLabel: input.community.communityLabel,
  };
}

function evidenceById(
  rows: Array<{ knowledgeId: string; sourceRefCount: number; originRefCount: number }>,
): Map<string, { sourceRefCount: number; originRefCount: number }> {
  return new Map(
    rows.map((row) => [
      row.knowledgeId,
      { sourceRefCount: row.sourceRefCount, originRefCount: row.originRefCount },
    ]),
  );
}

function compareDirection(input: DeadZoneKnowledgeReviewQuery): 1 | -1 {
  return input.sortDir === "asc" ? 1 : -1;
}

function strongestSimilarity(item: DeadZoneKnowledgeReviewItem): number {
  return item.similarKnowledge[0]?.similarity ?? 0;
}

function strengthRank(value: string): number {
  switch (value) {
    case "none":
      return 0;
    case "thin":
    case "low":
      return 1;
    case "moderate":
      return 2;
    case "strong":
      return 3;
    default:
      return 0;
  }
}

function strongerThan(left: string, right: string): boolean {
  return strengthRank(left) > strengthRank(right);
}

function decideDeadZoneRecommendation(input: {
  knowledge: DeadZoneScoringKnowledge;
  evidenceStrength: DeadZoneKnowledgeReviewItem["indicators"]["evidenceStrength"];
  usageStrength: DeadZoneKnowledgeReviewItem["indicators"]["usageStrength"];
  structureQuality: DeadZoneKnowledgeReviewItem["indicators"]["structureQuality"];
  bestCanonicalCandidate: DeadZoneKnowledgeReviewItem["bestCanonicalCandidate"];
  similarKnowledge: DeadZoneKnowledgeReviewItem["similarKnowledge"];
}): Pick<DeadZoneKnowledgeReviewItem, "recommendation" | "allowedActions"> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const allowed = new Set<DeadZoneRecommendationAction>(["keep_separate", "needs_evidence"]);
  const best = input.bestCanonicalCandidate;

  if (!input.knowledge.embedded) {
    blockers.push("missing embedding");
    reasons.push("Similarity cannot be trusted until the DeadZone item has an embedding.");
    return {
      recommendation: {
        action: "needs_evidence",
        confidence: "high",
        reasons,
        blockers,
      },
      allowedActions: [...allowed],
    };
  }

  if (best?.status === "deprecated") {
    blockers.push("deprecated candidate cannot be canonical");
  }

  if (best?.applicabilityMatch === "low") {
    blockers.push("low scope overlap");
  }

  const weakDeadZone =
    (input.evidenceStrength === "none" || input.evidenceStrength === "thin") &&
    input.usageStrength === "none";
  if (weakDeadZone) allowed.add("deprecate_deadzone");

  if (best && best.status === "active" && best.applicabilityMatch !== "low") {
    const targetStronger =
      strongerThan(best.evidenceStrength, input.evidenceStrength) ||
      strongerThan(best.usageStrength, input.usageStrength);
    const deadZoneStronger =
      strongerThan(input.evidenceStrength, best.evidenceStrength) ||
      strongerThan(input.usageStrength, best.usageStrength);

    if (targetStronger) {
      allowed.add("merge_deadzone_into_canonical");
      reasons.push(...best.reasons.slice(0, 3), "canonical candidate has stronger signals");
      return {
        recommendation: {
          action: "merge_deadzone_into_canonical",
          confidence:
            best.applicabilityMatch === "high" && best.similarity >= 0.9 ? "high" : "medium",
          reasons,
          blockers,
        },
        allowedActions: [...allowed],
      };
    }

    if (deadZoneStronger || best.suggestedAction === "deadzone_is_canonical") {
      allowed.add("promote_deadzone");
      reasons.push("DeadZone item has stronger retention or evidence signals.");
      return {
        recommendation: {
          action: "promote_deadzone",
          confidence: deadZoneStronger ? "medium" : "low",
          reasons,
          blockers,
        },
        allowedActions: [...allowed],
      };
    }

    if (best.suggestedAction === "scope_differs") {
      reasons.push(...best.reasons.slice(0, 3));
      return {
        recommendation: {
          action: "keep_separate",
          confidence: "medium",
          reasons,
          blockers,
        },
        allowedActions: [...allowed],
      };
    }
  }

  if (best?.applicabilityMatch === "low") {
    reasons.push(...best.reasons.slice(0, 3));
    return {
      recommendation: {
        action: "keep_separate",
        confidence: "medium",
        reasons,
        blockers,
      },
      allowedActions: [...allowed],
    };
  }

  if (weakDeadZone && input.structureQuality !== "strong") {
    reasons.push("DeadZone evidence and usage are weak.");
    return {
      recommendation: {
        action: "deprecate_deadzone",
        confidence: "medium",
        reasons,
        blockers,
      },
      allowedActions: [...allowed],
    };
  }

  reasons.push(
    input.similarKnowledge.length > 0
      ? "Similar knowledge is available, but signals are insufficient for a destructive action."
      : "No reliable canonical candidate was found.",
  );
  return {
    recommendation: {
      action: "needs_evidence",
      confidence: "low",
      reasons,
      blockers,
    },
    allowedActions: [...allowed],
  };
}

function sortDeadZoneReviewItems(
  items: DeadZoneKnowledgeReviewItem[],
  input: DeadZoneKnowledgeReviewQuery,
): DeadZoneKnowledgeReviewItem[] {
  const direction = compareDirection(input);
  return [...items].sort((left, right) => {
    const primary = (() => {
      switch (input.sortBy) {
        case "compileSelectCount":
          return left.knowledge.compileSelectCount - right.knowledge.compileSelectCount;
        case "title":
          return left.knowledge.title.localeCompare(right.knowledge.title);
        case "similarity":
          return strongestSimilarity(left) - strongestSimilarity(right);
        case "evidence":
          return (
            strengthRank(left.indicators.evidenceStrength) -
            strengthRank(right.indicators.evidenceStrength)
          );
        case "usage":
          return (
            strengthRank(left.indicators.usageStrength) -
            strengthRank(right.indicators.usageStrength)
          );
        default:
          return left.indicators.deadZoneScore - right.indicators.deadZoneScore;
      }
    })();
    return (
      primary * direction ||
      right.indicators.deadZoneScore - left.indicators.deadZoneScore ||
      left.knowledge.compileSelectCount - right.knowledge.compileSelectCount ||
      left.knowledge.title.localeCompare(right.knowledge.title)
    );
  });
}

function requireSimilarId(input: DeadZoneKnowledgeMaintenanceInput): string {
  if (!input.similarKnowledgeId) {
    throw new DeadZoneKnowledgeMaintenanceError(400, "similarKnowledgeId is required");
  }
  return input.similarKnowledgeId;
}

function appendMergedKnowledgeBody(params: {
  keptBody: string;
  deprecatedTitle: string;
  deprecatedBody: string;
}): string {
  return [
    params.keptBody.trim(),
    "",
    "Merged DeadZone knowledge:",
    `- Deprecated source: ${params.deprecatedTitle}`,
    "",
    params.deprecatedBody.trim(),
  ].join("\n");
}

export class DeadZoneKnowledgeMaintenanceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DeadZoneKnowledgeMaintenanceError";
    this.statusCode = statusCode;
  }
}

export async function buildDeadZoneKnowledgeReview(
  rawInput: DeadZoneKnowledgeReviewQuery,
): Promise<DeadZoneKnowledgeReviewResponse> {
  const input = deadZoneKnowledgeReviewQuerySchema.parse(rawInput);
  const generatedAt = new Date().toISOString();
  const landscape = await buildLandscapeSnapshot({
    windowDays: input.windowDays,
    limit: Math.max(input.limit, 1000),
    status: input.status,
    relationAxes: input.relationAxes,
    minSelectedCount: 3,
    minFeedbackCount: 3,
  });
  const deadZoneCommunities = landscape.communities.filter((community) => {
    if (!isDeadZoneCommunity(community)) return false;
    if (input.reason !== "all" && community.classification.primary !== input.reason) return false;
    if (input.communityKey && community.communityKey !== input.communityKey) return false;
    return true;
  });

  if (deadZoneCommunities.length === 0) {
    return deadZoneKnowledgeReviewResponseSchema.parse({
      generatedAt,
      windowDays: input.windowDays,
      minSimilarity: input.minSimilarity,
      similarTopK: input.similarTopK,
      communityCount: 0,
      itemCount: 0,
      unavailableReason: null,
      items: [],
    });
  }

  const graph = await buildGraphSnapshot({
    limit: Math.max(input.limit, 1000),
    status: input.status,
    view: "community",
    relationAxes: input.relationAxes,
    communityDisplay: "detail",
  });
  const deadCommunityByKey = new Map(
    deadZoneCommunities.map((community) => [community.communityKey, community]),
  );
  const candidateIds = new Set<string>();
  for (const community of deadZoneCommunities) {
    for (const knowledgeId of community.representativeKnowledgeIds) candidateIds.add(knowledgeId);
  }
  for (const node of graph.nodes) {
    if (node.kind !== "knowledge" || !node.communityKey) continue;
    if (!deadCommunityByKey.has(node.communityKey)) continue;
    candidateIds.add(asKnowledgeId(node.id));
  }

  const candidateRows = await listDeadZoneKnowledgeRows([...candidateIds]);
  const candidateRowById = new Map(candidateRows.map((row) => [row.id, row]));
  const candidatesByCommunityKey = new Map<string, DeadZoneKnowledgeRow[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "knowledge" || !node.communityKey) continue;
    const row = candidateRowById.get(asKnowledgeId(node.id));
    if (!row) continue;
    const rows = candidatesByCommunityKey.get(node.communityKey) ?? [];
    rows.push(row);
    candidatesByCommunityKey.set(node.communityKey, rows);
  }
  for (const community of deadZoneCommunities) {
    const rows = candidatesByCommunityKey.get(community.communityKey) ?? [];
    for (const knowledgeId of community.representativeKnowledgeIds) {
      const row = candidateRowById.get(knowledgeId);
      if (row && !rows.some((candidate) => candidate.id === row.id)) rows.push(row);
    }
    candidatesByCommunityKey.set(community.communityKey, rows);
  }

  const orderedCandidates = [...candidatesByCommunityKey.entries()].flatMap(
    ([communityKey, rows]) => {
      const community = deadCommunityByKey.get(communityKey);
      if (!community) return [];
      return rows.sort(sortCandidateRows).map((row) => ({ row, community }));
    },
  );
  const orderedIds = orderedCandidates.map((candidate) => candidate.row.id);

  const similarRows = await listSimilarKnowledgeRows({
    knowledgeIds: orderedIds,
    minSimilarity: input.minSimilarity,
    topK: input.similarTopK,
    status: "active",
  });
  const similarIds = similarRows.map((row) => row.id);
  const allEvidenceRows = await listDeadZoneKnowledgeEvidenceRows([...orderedIds, ...similarIds]);
  const evidence = evidenceById(allEvidenceRows);
  const reviewLinks = new Map(
    (await listDeadZoneReviewItemLinks(orderedIds)).map((row) => [
      row.knowledgeId,
      row.reviewItemId,
    ]),
  );
  const mergeReviewJobs = await listLatestDeadZoneMergeReviewJobsByDeadZoneIds(orderedIds);
  const similarBySource = new Map<string, typeof similarRows>();
  for (const row of similarRows) {
    const rows = similarBySource.get(row.sourceKnowledgeId) ?? [];
    rows.push(row);
    similarBySource.set(row.sourceKnowledgeId, rows);
  }

  const items: DeadZoneKnowledgeReviewItem[] = orderedCandidates.map(({ row, community }) => {
    const rowEvidence = evidence.get(row.id) ?? { sourceRefCount: 0, originRefCount: 0 };
    const sourceRefDensity =
      community.size > 0 ? rowEvidence.sourceRefCount / Math.max(1, community.size) : 0;
    const scoringKnowledge = toScoringKnowledge({
      row,
      sourceRefCount: rowEvidence.sourceRefCount,
      originRefCount: rowEvidence.originRefCount,
      sourceRefDensity,
    });
    const evidenceStrength = scoreEvidenceStrength(scoringKnowledge);
    const usageStrength = scoreUsageStrength(scoringKnowledge);
    const structureQuality = scoreStructureQuality(scoringKnowledge);
    const graphHealth = scoreGraphHealth({
      communitySize: community.size,
      sourceRefDensity: community.quality.sourceRefDensity,
    });

    const similarKnowledge = (similarBySource.get(row.id) ?? []).map((similar) => {
      const similarEvidence = evidence.get(similar.id) ?? { sourceRefCount: 0, originRefCount: 0 };
      const similarScoring = toScoringKnowledge({
        row: similar,
        sourceRefCount: similarEvidence.sourceRefCount,
        originRefCount: similarEvidence.originRefCount,
        sourceRefDensity: similarEvidence.sourceRefCount,
      });
      const applicability = scoreApplicabilityMatch(scoringKnowledge, similarScoring);
      const similarEvidenceStrength = scoreEvidenceStrength(similarScoring);
      const similarUsageStrength = scoreUsageStrength(similarScoring);
      const suggested = suggestedActionForSimilar({
        deadZoneEvidence: evidenceStrength,
        deadZoneUsage: usageStrength,
        similarEvidence: similarEvidenceStrength,
        similarUsage: similarUsageStrength,
        applicabilityMatch: applicability.label,
        similarity: similar.similarity,
        similarStatus: similar.status,
      });
      return {
        id: similar.id,
        title: similar.title,
        status: similar.status,
        similarity: similar.similarity,
        applicabilityMatch: applicability.label,
        evidenceStrength: similarEvidenceStrength,
        usageStrength: similarUsageStrength,
        suggestedAction: suggested.action,
        reasons: [...applicability.reasons, ...suggested.reasons],
      };
    });

    const bestCanonicalCandidate =
      similarKnowledge.find(
        (similar) =>
          similar.status === "active" &&
          similar.applicabilityMatch !== "low" &&
          (similar.suggestedAction === "merge_into_similar" ||
            similar.suggestedAction === "likely_duplicate" ||
            similar.suggestedAction === "deadzone_is_canonical"),
      ) ??
      similarKnowledge.find((similar) => similar.status === "active") ??
      null;
    const alternativeCandidates = similarKnowledge.filter(
      (similar) => similar.id !== bestCanonicalCandidate?.id,
    );
    const recommendation = decideDeadZoneRecommendation({
      knowledge: scoringKnowledge,
      evidenceStrength,
      usageStrength,
      structureQuality,
      bestCanonicalCandidate,
      similarKnowledge,
    });

    const badges = deriveDeadZoneReviewBadges({
      knowledge: scoringKnowledge,
      evidenceStrength,
      usageStrength,
      structureQuality,
      graphHealth,
      similarActions: similarKnowledge.map((similar) => similar.suggestedAction),
    });
    const allBadges: DeadZoneKnowledgeReviewBadge[] =
      row.embedded || similarKnowledge.length > 0 ? badges : [...badges, "Similarity unavailable"];
    const deadZoneScore = scoreDeadZoneRisk({
      evidenceStrength,
      usageStrength,
      structureQuality,
      graphHealth,
      badges: allBadges,
      similarActions: similarKnowledge.map((similar) => similar.suggestedAction),
      classificationPrimary: community.classification.primary as
        | "dead_zone_reachability_risk"
        | "dead_zone_stale",
      classificationConfidence: community.classification.confidence,
    });

    return {
      knowledge: knowledgeSummary({
        row,
        sourceRefCount: rowEvidence.sourceRefCount,
        sourceRefDensity,
        community,
      }),
      classification: {
        primary: community.classification.primary as
          | "dead_zone_reachability_risk"
          | "dead_zone_stale",
        confidence: community.classification.confidence,
        reason: community.classification.reason,
      },
      indicators: {
        deadZoneScore,
        evidenceStrength,
        usageStrength,
        structureQuality,
        graphHealth,
        badges: allBadges,
      },
      bestCanonicalCandidate,
      alternativeCandidates,
      recommendation: recommendation.recommendation,
      allowedActions: recommendation.allowedActions,
      similarKnowledge,
      reviewItemId: reviewLinks.get(row.id) ?? null,
      mergeReviewJob: mergeReviewJobs.get(row.id) ?? null,
    };
  });

  const filteredItems = (() => {
    if (input.badge === "all") return items;
    const badge: DeadZoneKnowledgeReviewBadge = input.badge;
    return items.filter((item) => item.indicators.badges.includes(badge));
  })();
  const sortedItems = sortDeadZoneReviewItems(filteredItems, input);
  const offset = (input.page - 1) * input.limit;

  return deadZoneKnowledgeReviewResponseSchema.parse({
    generatedAt,
    windowDays: input.windowDays,
    minSimilarity: input.minSimilarity,
    similarTopK: input.similarTopK,
    communityCount: deadZoneCommunities.length,
    itemCount: filteredItems.length,
    unavailableReason: null,
    items: sortedItems.slice(offset, offset + input.limit),
  });
}

function requireCanonicalId(input: DeadZoneKnowledgeReviewActionInput): string {
  if (!input.canonicalKnowledgeId) {
    throw new DeadZoneKnowledgeMaintenanceError(400, "canonicalKnowledgeId is required");
  }
  return input.canonicalKnowledgeId;
}

export async function applyDeadZoneKnowledgeReviewAction(
  input: DeadZoneKnowledgeReviewActionInput,
): Promise<DeadZoneKnowledgeReviewActionResult> {
  const deadZoneId = input.deadZoneKnowledgeId;
  const ids = [
    ...new Set([deadZoneId, input.canonicalKnowledgeId].filter((id): id is string => Boolean(id))),
  ];
  const rows = await loadKnowledgeTitleStatusRows(ids);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const deadZone = rowById.get(deadZoneId);
  if (!deadZone) throw new DeadZoneKnowledgeMaintenanceError(404, "deadZone knowledge not found");

  if (input.action === "merge_deadzone_into_canonical") {
    const canonicalId = requireCanonicalId(input);
    if (canonicalId === deadZoneId) {
      throw new DeadZoneKnowledgeMaintenanceError(
        400,
        "canonicalKnowledgeId must differ from deadZoneKnowledgeId",
      );
    }
    const canonical = rowById.get(canonicalId);
    if (!canonical)
      throw new DeadZoneKnowledgeMaintenanceError(404, "canonical knowledge not found");
    if (canonical.status !== "active") {
      throw new DeadZoneKnowledgeMaintenanceError(400, "canonical target must be active");
    }
    const result = await maintainDeadZoneKnowledge({
      action: "merge_deadzone_into_similar",
      deadZoneKnowledgeId: deadZoneId,
      similarKnowledgeId: canonicalId,
    });
    const message = `Merged DeadZone "${deadZone.title}" into canonical "${canonical.title}" and deprecated "${deadZone.title}".`;
    const reviewItemId = await recordDeadZoneReviewDecision({
      reviewItemId: input.reviewItemId,
      deadZoneKnowledgeId: deadZoneId,
      canonicalKnowledgeId: canonicalId,
      action: input.action,
      note: input.note,
      status: "applied",
      message,
    });
    return {
      action: input.action,
      status: "applied",
      message,
      keptKnowledgeId: result.keptKnowledgeId ?? undefined,
      deprecatedKnowledgeId: result.deprecatedKnowledgeId,
      reviewItemId,
    };
  }

  if (input.action === "deprecate_deadzone") {
    const result = await maintainDeadZoneKnowledge({
      action: "deprecate_deadzone",
      deadZoneKnowledgeId: deadZoneId,
    });
    const message = `Deprecated DeadZone "${deadZone.title}".`;
    const reviewItemId = await recordDeadZoneReviewDecision({
      reviewItemId: input.reviewItemId,
      deadZoneKnowledgeId: deadZoneId,
      action: input.action,
      note: input.note,
      status: "applied",
      message,
    });
    return {
      action: input.action,
      status: "applied",
      message,
      deprecatedKnowledgeId: result.deprecatedKnowledgeId,
      reviewItemId,
    };
  }

  const messages: Record<DeadZoneRecommendationAction, string> = {
    merge_deadzone_into_canonical: "",
    deprecate_deadzone: "",
    keep_separate: `Recorded Keep separate for "${deadZone.title}".`,
    promote_deadzone: `Recorded Promote DeadZone for "${deadZone.title}".`,
    needs_evidence: `Marked "${deadZone.title}" as Needs evidence.`,
  };
  const message = messages[input.action];
  const reviewItemId = await recordDeadZoneReviewDecision({
    reviewItemId: input.reviewItemId,
    deadZoneKnowledgeId: deadZoneId,
    action: input.action,
    note: input.note,
    status: "recorded",
    message,
  });
  return {
    action: input.action,
    status: "recorded",
    message,
    keptKnowledgeId: deadZoneId,
    reviewItemId,
  };
}

export async function maintainDeadZoneKnowledge(
  input: DeadZoneKnowledgeMaintenanceInput,
): Promise<DeadZoneKnowledgeMaintenanceResult> {
  const similarKnowledgeId =
    input.action === "merge_deadzone_into_similar" ||
    input.action === "merge_similar_into_deadzone" ||
    input.action === "deprecate_similar"
      ? requireSimilarId(input)
      : null;

  const ids = [
    ...new Set(
      [input.deadZoneKnowledgeId, similarKnowledgeId].filter((id): id is string => Boolean(id)),
    ),
  ];
  const rows = await loadKnowledgeMaintenanceRows(ids);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const deadZone = rowById.get(input.deadZoneKnowledgeId);
  if (!deadZone) throw new DeadZoneKnowledgeMaintenanceError(404, "deadZone knowledge not found");
  const similar = similarKnowledgeId ? rowById.get(similarKnowledgeId) : null;
  if (similarKnowledgeId && !similar) {
    throw new DeadZoneKnowledgeMaintenanceError(404, "similar knowledge not found");
  }

  if (input.action === "deprecate_deadzone") {
    await updateKnowledgeItem(input.deadZoneKnowledgeId, { status: "deprecated" });
    return {
      action: input.action,
      keptKnowledgeId: null,
      deprecatedKnowledgeId: input.deadZoneKnowledgeId,
    };
  }

  if (input.action === "deprecate_similar") {
    if (!similarKnowledgeId) {
      throw new DeadZoneKnowledgeMaintenanceError(400, "similarKnowledgeId is required");
    }
    await updateKnowledgeItem(similarKnowledgeId, { status: "deprecated" });
    return {
      action: input.action,
      keptKnowledgeId: input.deadZoneKnowledgeId,
      deprecatedKnowledgeId: similarKnowledgeId,
    };
  }

  if (!similar) throw new DeadZoneKnowledgeMaintenanceError(400, "similarKnowledgeId is required");
  const keep =
    input.action === "merge_deadzone_into_similar"
      ? similar
      : input.action === "merge_similar_into_deadzone"
        ? deadZone
        : null;
  const deprecate =
    input.action === "merge_deadzone_into_similar"
      ? deadZone
      : input.action === "merge_similar_into_deadzone"
        ? similar
        : null;
  if (!keep || !deprecate) throw new DeadZoneKnowledgeMaintenanceError(400, "unsupported action");

  await updateKnowledgeItem(keep.id, {
    body: appendMergedKnowledgeBody({
      keptBody: keep.body,
      deprecatedTitle: deprecate.title,
      deprecatedBody: deprecate.body,
    }),
  });
  await updateKnowledgeItem(deprecate.id, { status: "deprecated" });

  return {
    action: input.action,
    keptKnowledgeId: keep.id,
    deprecatedKnowledgeId: deprecate.id,
  };
}
