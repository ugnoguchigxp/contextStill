import { buildGraphSnapshot } from "../../../api/modules/graph/graph.repository.js";
import { computeDecayFactor } from "../knowledge/knowledge-value.service.js";
import { runWithLandscapeSnapshotCache } from "./landscape-snapshot-cache.service.js";
import {
  loadLandscapeFeedbackAggregates,
  loadLandscapeKnowledgeRows,
  loadLandscapeSelectionAggregates,
  loadLandscapeSelectionPairs,
  loadLandscapeSourceRefCountMap,
} from "./landscape.repository.js";
import { LANDSCAPE_DEFAULT_THRESHOLDS, scoreLandscapeCommunity } from "./landscape.scoring.js";
import type {
  BuildLandscapeSnapshotInput,
  LandscapeCommunity,
  LandscapeGraphRelationAxis,
  LandscapeGraphStatusFilter,
  LandscapeRisk,
  LandscapeSnapshot,
  LandscapeThresholds,
} from "./landscape.types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asKnowledgeNodeId(nodeId: string): string {
  return nodeId.replace(/^knowledge:/, "");
}

function normalizeKnowledgeType(type: string): "rule" | "procedure" {
  return type === "procedure" ? "procedure" : "rule";
}

function normalizeKnowledgeScope(scope: string): "repo" | "global" {
  return scope === "global" ? "global" : "repo";
}

function mergeThresholds(input: {
  minSelectedCount: number;
  minFeedbackCount: number;
}): LandscapeThresholds {
  return {
    ...LANDSCAPE_DEFAULT_THRESHOLDS,
    minSelectedCount: input.minSelectedCount,
    minFeedbackCount: input.minFeedbackCount,
  };
}

function buildGraphStatusFilter(status: LandscapeGraphStatusFilter) {
  return status;
}

function severityRank(value: "low" | "medium" | "high"): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function buildGraphRelationAxes(
  relationAxes: LandscapeGraphRelationAxis[],
): Array<"session" | "project" | "source"> {
  const normalized = new Set<"session" | "project" | "source">();
  for (const axis of relationAxes) {
    if (axis === "session" || axis === "project" || axis === "source") {
      normalized.add(axis);
    }
  }
  return normalized.size > 0 ? [...normalized] : ["session", "project", "source"];
}

export async function buildLandscapeSnapshot(
  input: BuildLandscapeSnapshotInput,
): Promise<LandscapeSnapshot> {
  return runWithLandscapeSnapshotCache({
    snapshotType: "landscape_snapshot",
    params: {
      ...input,
    },
    build: async () => {
      const thresholds = mergeThresholds({
        minSelectedCount: input.minSelectedCount,
        minFeedbackCount: input.minFeedbackCount,
      });
      const status = buildGraphStatusFilter(input.status);
      const relationAxes = buildGraphRelationAxes(input.relationAxes);

      const graphSnapshot = await buildGraphSnapshot({
        limit: input.limit,
        status,
        view: "community",
        relationAxes,
        communityDisplay: "detail",
      });

      const memberKnowledgeIdsByCommunityKey = new Map<string, string[]>();

      for (const node of graphSnapshot.nodes) {
        if (node.kind !== "knowledge") continue;
        if (!node.communityKey) continue;
        const knowledgeId = asKnowledgeNodeId(node.id);
        const ids = memberKnowledgeIdsByCommunityKey.get(node.communityKey) ?? [];
        ids.push(knowledgeId);
        memberKnowledgeIdsByCommunityKey.set(node.communityKey, ids);
      }

      const allKnowledgeIds = [...new Set([...memberKnowledgeIdsByCommunityKey.values()].flat())];
      const [knowledgeRows, selectionRows, selectionPairs, feedbackRows] = await Promise.all([
        loadLandscapeKnowledgeRows(allKnowledgeIds),
        loadLandscapeSelectionAggregates({
          knowledgeIds: allKnowledgeIds,
          windowDays: input.windowDays,
        }),
        loadLandscapeSelectionPairs({
          knowledgeIds: allKnowledgeIds,
          windowDays: input.windowDays,
        }),
        loadLandscapeFeedbackAggregates({
          knowledgeIds: allKnowledgeIds,
          windowDays: input.windowDays,
        }),
      ]);
      const sourceRefCountByKnowledgeId = await loadLandscapeSourceRefCountMap(knowledgeRows);

      const knowledgeRowById = new Map(knowledgeRows.map((row) => [row.id, row]));
      const selectionByKnowledgeId = new Map(
        selectionRows.map((row) => [
          row.knowledgeId,
          {
            selectedItemCountWindow: row.selectedItemCountWindow,
            selectedRunCountWindow: row.selectedRunCountWindow,
          },
        ]),
      );
      const runIdsByKnowledgeId = new Map<string, Set<string>>();
      for (const pair of selectionPairs) {
        const runIds = runIdsByKnowledgeId.get(pair.knowledgeId) ?? new Set<string>();
        runIds.add(pair.runId);
        runIdsByKnowledgeId.set(pair.knowledgeId, runIds);
      }
      const feedbackByKnowledgeId = new Map(
        feedbackRows.map((row) => [
          row.knowledgeId,
          {
            usedCountWindow: row.usedCountWindow,
            notUsedCountWindow: row.notUsedCountWindow,
            offTopicCountWindow: row.offTopicCountWindow,
            wrongCountWindow: row.wrongCountWindow,
          },
        ]),
      );

      const communities: LandscapeCommunity[] = [];
      for (const summary of graphSnapshot.communities) {
        const memberKnowledgeIds = memberKnowledgeIdsByCommunityKey.get(summary.communityKey) ?? [];
        const memberRows = memberKnowledgeIds
          .map((knowledgeId) => knowledgeRowById.get(knowledgeId))
          .filter((row): row is NonNullable<typeof row> => Boolean(row));

        const memberCounts = {
          active: 0,
          draft: 0,
          deprecated: 0,
          rule: 0,
          procedure: 0,
          embedded: 0,
        };

        let selectedItemCountWindow = 0;
        const selectedRunIdSet = new Set<string>();
        let cumulativeCompileSelectCount = 0;
        let zeroUseActiveCount = 0;

        let usedCountWindow = 0;
        let notUsedCountWindow = 0;
        let offTopicCountWindow = 0;
        let wrongCountWindow = 0;

        let importanceTotal = 0;
        let confidenceTotal = 0;
        let dynamicScoreTotal = 0;
        let freshnessTotal = 0;
        let sourceRefCount = 0;

        const representativeCandidates: Array<{
          knowledgeId: string;
          selectedItemCountWindow: number;
          compileSelectCount: number;
          dynamicScore: number;
        }> = [];

        for (const row of memberRows) {
          if (row.status === "active") memberCounts.active += 1;
          if (row.status === "draft") memberCounts.draft += 1;
          if (row.status === "deprecated") memberCounts.deprecated += 1;

          if (row.type === "procedure") {
            memberCounts.procedure += 1;
          } else {
            memberCounts.rule += 1;
          }
          if (row.embedded) memberCounts.embedded += 1;

          const selection = selectionByKnowledgeId.get(row.id);
          selectedItemCountWindow += selection?.selectedItemCountWindow ?? 0;
          for (const runId of runIdsByKnowledgeId.get(row.id) ?? []) {
            selectedRunIdSet.add(runId);
          }
          cumulativeCompileSelectCount += row.compileSelectCount;
          if (row.status === "active" && row.compileSelectCount === 0) {
            zeroUseActiveCount += 1;
          }

          const feedback = feedbackByKnowledgeId.get(row.id);
          usedCountWindow += feedback?.usedCountWindow ?? 0;
          notUsedCountWindow += feedback?.notUsedCountWindow ?? 0;
          offTopicCountWindow += feedback?.offTopicCountWindow ?? 0;
          wrongCountWindow += feedback?.wrongCountWindow ?? 0;

          importanceTotal += row.importance;
          confidenceTotal += row.confidence;
          dynamicScoreTotal += row.dynamicScore;
          const freshnessFactor = computeDecayFactor({
            type: normalizeKnowledgeType(row.type),
            scope: normalizeKnowledgeScope(row.scope),
            lastVerifiedAt: row.lastVerifiedAt,
            updatedAt: row.updatedAt,
          });
          freshnessTotal += freshnessFactor;
          sourceRefCount += sourceRefCountByKnowledgeId.get(row.id) ?? 0;

          representativeCandidates.push({
            knowledgeId: row.id,
            selectedItemCountWindow: selection?.selectedItemCountWindow ?? 0,
            compileSelectCount: row.compileSelectCount,
            dynamicScore: row.dynamicScore,
          });
        }

        const memberCount = Math.max(1, memberRows.length);
        const avgImportance = importanceTotal / memberCount;
        const avgConfidence = confidenceTotal / memberCount;
        const avgDynamicScore = dynamicScoreTotal / memberCount;
        const avgFreshnessFactor = clamp(freshnessTotal / memberCount, 0, 1);
        const avgStalenessFactor = clamp(1 - avgFreshnessFactor, 0, 1);
        const sourceRefDensity = summary.size > 0 ? sourceRefCount / summary.size : 0;
        const zeroUseActiveRatio =
          memberCounts.active > 0 ? zeroUseActiveCount / memberCounts.active : 0;
        const embeddedRatio = summary.size > 0 ? memberCounts.embedded / summary.size : 0;

        const scoring = scoreLandscapeCommunity(
          {
            selectedItemCountWindow,
            cumulativeCompileSelectCount,
            activeCount: memberCounts.active,
            embeddedRatio,
            zeroUseActiveCount,
            usedCountWindow,
            notUsedCountWindow,
            offTopicCountWindow,
            wrongCountWindow,
            sourceRefDensity,
            avgImportance,
            avgConfidence,
            avgFreshnessFactor,
            avgStalenessFactor,
            minSelectedCount: thresholds.minSelectedCount,
            minFeedbackCount: thresholds.minFeedbackCount,
          },
          thresholds,
        );

        representativeCandidates.sort(
          (a, b) =>
            b.selectedItemCountWindow - a.selectedItemCountWindow ||
            b.compileSelectCount - a.compileSelectCount ||
            b.dynamicScore - a.dynamicScore ||
            a.knowledgeId.localeCompare(b.knowledgeId),
        );

        communities.push({
          communityId: summary.communityId,
          communityKey: summary.communityKey,
          communityLabel: summary.communityLabel,
          communityRank: summary.communityRank,
          size: summary.size,
          memberCounts,
          selection: {
            selectedItemCountWindow,
            selectedRunCountWindow: selectedRunIdSet.size,
            cumulativeCompileSelectCount,
            zeroUseActiveCount,
            zeroUseActiveRatio,
          },
          feedback: {
            usedCountWindow,
            notUsedCountWindow,
            offTopicCountWindow,
            wrongCountWindow,
            feedbackCountWindow: scoring.feedbackCountWindow,
            usedRate: scoring.usedRate,
            notUsedRate: scoring.notUsedRate,
            offTopicRate: scoring.offTopicRate,
            wrongRate: scoring.wrongRate,
            feedbackConfidence: scoring.feedbackConfidence,
          },
          quality: {
            avgImportance,
            avgConfidence,
            avgDynamicScore,
            sourceRefCount,
            sourceRefDensity,
            avgFreshnessFactor,
            avgStalenessFactor,
          },
          scores: {
            activity: selectedItemCountWindow,
            attractorScore: scoring.attractorScore,
            negativeScore: scoring.negativeScore,
            reachabilityRiskScore: scoring.reachabilityRiskScore,
          },
          classification: {
            primary: scoring.classification.primary,
            flags: scoring.classification.flags,
            confidence: scoring.classification.confidence,
            reason: scoring.classification.reason,
          },
          recommendedActions: scoring.recommendedActions,
          representativeKnowledgeIds: representativeCandidates
            .slice(0, 5)
            .map((candidate) => candidate.knowledgeId),
        });
      }

      communities.sort((a, b) => a.communityRank - b.communityRank);

      const risks: LandscapeRisk[] = [];
      for (const community of communities) {
        const primary = community.classification.primary;
        if (
          primary === "negative_attractor_candidate" ||
          primary === "over_selected_not_used" ||
          primary === "dead_zone_reachability_risk" ||
          primary === "dead_zone_stale"
        ) {
          risks.push({
            communityId: community.communityId,
            communityKey: community.communityKey,
            communityLabel: community.communityLabel,
            communityRank: community.communityRank,
            type: primary,
            severity: community.classification.confidence,
            reason: community.classification.reason,
          });
        }
        if (community.classification.flags.includes("wrong_review_required")) {
          risks.push({
            communityId: community.communityId,
            communityKey: community.communityKey,
            communityLabel: community.communityLabel,
            communityRank: community.communityRank,
            type: "wrong_review_required",
            severity: "high",
            reason: "wrong verdict が観測されました。優先レビュー対象です。",
          });
        }
      }

      const stats = {
        totalCommunities: communities.length,
        activeCommunities: communities.filter((community) => community.memberCounts.active > 0)
          .length,
        selectedCommunities: communities.filter(
          (community) => community.selection.selectedItemCountWindow > 0,
        ).length,
        insufficientFeedbackCommunities: communities.filter(
          (community) => community.feedback.feedbackConfidence === "insufficient",
        ).length,
        strongAttractorCount: communities.filter(
          (community) => community.classification.primary === "strong_attractor",
        ).length,
        usefulAttractorCount: communities.filter(
          (community) => community.classification.primary === "useful_attractor",
        ).length,
        negativeCandidateCount: communities.filter(
          (community) => community.classification.primary === "negative_attractor_candidate",
        ).length,
        overSelectedNotUsedCount: communities.filter(
          (community) => community.classification.primary === "over_selected_not_used",
        ).length,
        deadZoneReachabilityCount: communities.filter(
          (community) => community.classification.primary === "dead_zone_reachability_risk",
        ).length,
        deadZoneStaleCount: communities.filter(
          (community) => community.classification.primary === "dead_zone_stale",
        ).length,
      };

      return {
        generatedAt: new Date().toISOString(),
        windowDays: input.windowDays,
        basis: {
          unit: "community",
          relationAxes,
          status,
        },
        thresholds,
        stats,
        communities,
        risks: risks.sort(
          (a, b) =>
            severityRank(b.severity) - severityRank(a.severity) ||
            a.communityRank - b.communityRank ||
            a.type.localeCompare(b.type),
        ),
      };
    },
  });
}
