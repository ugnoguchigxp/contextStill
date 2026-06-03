import { buildGraphSnapshot } from "../../../api/modules/graph/graph.repository.js";
import {
  type DeadZoneKnowledgeReviewBadge,
  type DeadZoneKnowledgeReviewItem,
  type DeadZoneKnowledgeReviewQuery,
  type DeadZoneKnowledgeReviewResponse,
  deadZoneKnowledgeReviewResponseSchema,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";
import type { LandscapeCommunity } from "./landscape.types.js";
import {
  deriveDeadZoneReviewBadges,
  scoreApplicabilityMatch,
  scoreEvidenceStrength,
  scoreGraphHealth,
  scoreStructureQuality,
  scoreUsageStrength,
  suggestedActionForSimilar,
  type DeadZoneScoringKnowledge,
} from "./landscape-deadzone-review.scoring.js";
import {
  type DeadZoneKnowledgeRow,
  listDeadZoneKnowledgeEvidenceRows,
  listDeadZoneKnowledgeRows,
  listDeadZoneReviewItemLinks,
  listSimilarKnowledgeRows,
} from "./landscape-deadzone-review.repository.js";
import { buildLandscapeSnapshot } from "./landscape.service.js";

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

export async function buildDeadZoneKnowledgeReview(
  input: DeadZoneKnowledgeReviewQuery,
): Promise<DeadZoneKnowledgeReviewResponse> {
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

  const orderedCandidates = [...candidatesByCommunityKey.entries()]
    .flatMap(([communityKey, rows]) => {
      const community = deadCommunityByKey.get(communityKey);
      if (!community) return [];
      return rows.sort(sortCandidateRows).map((row) => ({ row, community }));
    })
    .slice(0, input.limit);
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
        evidenceStrength,
        usageStrength,
        structureQuality,
        graphHealth,
        badges: allBadges,
      },
      similarKnowledge,
      reviewItemId: reviewLinks.get(row.id) ?? null,
    };
  });

  const filteredItems = (() => {
    if (input.badge === "all") return items;
    const badge: DeadZoneKnowledgeReviewBadge = input.badge;
    return items.filter((item) => item.indicators.badges.includes(badge));
  })();

  return deadZoneKnowledgeReviewResponseSchema.parse({
    generatedAt,
    windowDays: input.windowDays,
    minSimilarity: input.minSimilarity,
    similarTopK: input.similarTopK,
    communityCount: deadZoneCommunities.length,
    itemCount: filteredItems.length,
    unavailableReason: null,
    items: filteredItems,
  });
}
