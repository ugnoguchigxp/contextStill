import { buildGraphSnapshot } from "../../../api/modules/graph/graph.repository.js";
import {
  extractLandscapeTaskFacets,
  enumerateLandscapeTaskFacetEntries,
} from "./landscape-facets.js";
import {
  buildLandscapeCommunityComparison,
  type LandscapeRelationCommunityAssignment,
} from "./landscape-community-comparison.js";
import { loadLandscapeReplayCorpus } from "./landscape-replay.repository.js";
import { runWithLandscapeSnapshotCache } from "./landscape-snapshot-cache.service.js";
import type {
  BuildLandscapeReplaySnapshotInput,
  LandscapeAcceptanceWindowSummary,
  LandscapeBasinExplanation,
  LandscapeBasinTrace,
  LandscapeCommunityReplaySummary,
  LandscapeFacetBasinSummary,
  LandscapeReplayRun,
  LandscapeReplaySnapshot,
  LandscapeUsageVerdict,
  LandscapeVerdictMix,
} from "./landscape-replay.types.js";
import { buildLandscapeSnapshot } from "./landscape.service.js";
import type {
  LandscapeClassificationConfidence,
  LandscapeClassificationPrimary,
  LandscapeCommunity,
  LandscapeFeedbackConfidence,
} from "./landscape.types.js";

type RelationCommunityAssignment = LandscapeRelationCommunityAssignment & {
  communityLabel: string;
  communityRank: number;
};

type PackItemForReplay = {
  itemId: string;
  score: number;
  createdAt: Date;
};

type UsageEventForReplay = {
  runId: string;
  knowledgeId: string;
  verdict: LandscapeUsageVerdict;
  actor: "agent" | "user" | "system";
  metadata: Record<string, unknown>;
};

function emptyVerdictMix(): LandscapeVerdictMix {
  return { used: 0, notUsed: 0, offTopic: 0, wrong: 0 };
}

function emptyExplanationCounts(): Record<LandscapeBasinExplanation, number> {
  return {
    aligned_attractor: 0,
    negative_explained: 0,
    dead_zone_missed: 0,
    over_selected: 0,
    unexplained: 0,
  };
}

function addVerdictMix(target: LandscapeVerdictMix, source: LandscapeVerdictMix): void {
  target.used += source.used;
  target.notUsed += source.notUsed;
  target.offTopic += source.offTopic;
  target.wrong += source.wrong;
}

function incrementVerdict(target: LandscapeVerdictMix, verdict: LandscapeUsageVerdict): void {
  if (verdict === "used") target.used += 1;
  if (verdict === "not_used") target.notUsed += 1;
  if (verdict === "off_topic") target.offTopic += 1;
  if (verdict === "wrong") target.wrong += 1;
}

function feedbackCount(mix: LandscapeVerdictMix): number {
  return mix.used + mix.notUsed + mix.offTopic + mix.wrong;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function asKnowledgeNodeId(nodeId: string): string {
  return nodeId.replace(/^knowledge:/, "");
}

function orderPackItems(items: PackItemForReplay[]): PackItemForReplay[] {
  return [...items].sort(
    (a, b) =>
      b.score - a.score ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      a.itemId.localeCompare(b.itemId),
  );
}

function buildSelectedRankMap(items: PackItemForReplay[]): Map<string, number> {
  const rankByKnowledgeId = new Map<string, number>();
  for (const [index, item] of orderPackItems(items).entries()) {
    if (rankByKnowledgeId.has(item.itemId)) continue;
    rankByKnowledgeId.set(item.itemId, index + 1);
  }
  return rankByKnowledgeId;
}

export function explainLandscapeBasinTrace(input: {
  classificationAtAnalysis: LandscapeClassificationPrimary;
  verdictMix: LandscapeVerdictMix;
}): LandscapeBasinExplanation {
  if (
    (input.classificationAtAnalysis === "strong_attractor" ||
      input.classificationAtAnalysis === "useful_attractor") &&
    input.verdictMix.used > 0
  ) {
    return "aligned_attractor";
  }
  if (
    input.classificationAtAnalysis === "negative_attractor_candidate" &&
    input.verdictMix.offTopic + input.verdictMix.wrong > 0
  ) {
    return "negative_explained";
  }
  if (input.classificationAtAnalysis === "over_selected_not_used" && input.verdictMix.notUsed > 0) {
    return "over_selected";
  }
  return "unexplained";
}

function buildCommunityTrace(params: {
  assignment: RelationCommunityAssignment;
  community: LandscapeCommunity | undefined;
  selectedItemCount: number;
  selectedRanks: number[];
  verdictMix: LandscapeVerdictMix;
  explanation?: LandscapeBasinExplanation;
}): LandscapeBasinTrace {
  const classificationAtAnalysis =
    params.community?.classification.primary ?? params.assignment.classificationAtAnalysis;
  return {
    communityKey: params.assignment.communityKey,
    communityLabel: params.community?.communityLabel ?? params.assignment.communityLabel,
    communityRank: params.community?.communityRank ?? params.assignment.communityRank,
    selectedItemCount: params.selectedItemCount,
    selectedRanks: [...params.selectedRanks].sort((a, b) => a - b),
    classificationAtAnalysis,
    classificationConfidenceAtAnalysis: params.community?.classification.confidence ?? "low",
    feedbackConfidenceAtAnalysis: params.community?.feedback.feedbackConfidence ?? "insufficient",
    verdictMix: params.verdictMix,
    explanation:
      params.explanation ??
      explainLandscapeBasinTrace({
        classificationAtAnalysis,
        verdictMix: params.verdictMix,
      }),
  };
}

function buildAcceptanceWindowSummary(
  events: UsageEventForReplay[],
): LandscapeAcceptanceWindowSummary {
  let acceptedCountWindow = 0;
  let unknownAcceptanceCountWindow = 0;
  let agentActorEventCountWindow = 0;
  let knownAcceptanceCount = 0;
  const acceptedRunIds = new Set<string>();

  for (const event of events) {
    if (event.actor === "agent") agentActorEventCountWindow += 1;
    if (Object.prototype.hasOwnProperty.call(event.metadata, "agenticAccepted")) {
      knownAcceptanceCount += 1;
      if (event.metadata.agenticAccepted === true) {
        acceptedCountWindow += 1;
        acceptedRunIds.add(event.runId);
      }
    } else {
      unknownAcceptanceCountWindow += 1;
    }
  }

  return {
    eventCountWindow: events.length,
    acceptedCountWindow,
    acceptedRunCountWindow: acceptedRunIds.size,
    unknownAcceptanceCountWindow,
    agentActorEventCountWindow,
    acceptanceRateKnownWindow: rate(acceptedCountWindow, knownAcceptanceCount),
    acceptanceCoverageRate: rate(knownAcceptanceCount, events.length),
  };
}

function asClassificationConfidence(value: unknown): LandscapeClassificationConfidence {
  return value === "high" || value === "medium" ? value : "low";
}

function asFeedbackConfidence(value: unknown): LandscapeFeedbackConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "insufficient";
}

function summarizeReplayCommunities(
  runs: LandscapeReplayRun[],
  acceptanceEventsByCommunityKey: Map<string, UsageEventForReplay[]>,
): LandscapeCommunityReplaySummary[] {
  const aggregateByCommunityKey = new Map<
    string,
    {
      communityLabel: string;
      communityRank: number;
      classificationAtAnalysis: LandscapeClassificationPrimary;
      runIds: Set<string>;
      traceCount: number;
      tracesWithFeedback: number;
      selectedItemCount: number;
      verdictMix: LandscapeVerdictMix;
      explanationCounts: Record<LandscapeBasinExplanation, number>;
    }
  >();

  for (const run of runs) {
    for (const trace of run.basinTrace) {
      const aggregate = aggregateByCommunityKey.get(trace.communityKey) ?? {
        communityLabel: trace.communityLabel,
        communityRank: trace.communityRank,
        classificationAtAnalysis: trace.classificationAtAnalysis,
        runIds: new Set<string>(),
        traceCount: 0,
        tracesWithFeedback: 0,
        selectedItemCount: 0,
        verdictMix: emptyVerdictMix(),
        explanationCounts: emptyExplanationCounts(),
      };
      aggregate.runIds.add(run.runId);
      aggregate.traceCount += 1;
      if (feedbackCount(trace.verdictMix) > 0) aggregate.tracesWithFeedback += 1;
      aggregate.selectedItemCount += trace.selectedItemCount;
      addVerdictMix(aggregate.verdictMix, trace.verdictMix);
      aggregate.explanationCounts[trace.explanation] += 1;
      aggregateByCommunityKey.set(trace.communityKey, aggregate);
    }
  }

  return [...aggregateByCommunityKey.entries()]
    .map(([communityKey, aggregate]) => ({
      communityKey,
      communityLabel: aggregate.communityLabel,
      communityRank: aggregate.communityRank,
      replayRunCount: aggregate.runIds.size,
      selectedItemCount: aggregate.selectedItemCount,
      classificationAtAnalysis: aggregate.classificationAtAnalysis,
      verdictMix: aggregate.verdictMix,
      explanationCounts: aggregate.explanationCounts,
      feedbackCoverageRate: rate(aggregate.tracesWithFeedback, aggregate.traceCount),
      acceptanceWindow: buildAcceptanceWindowSummary(
        acceptanceEventsByCommunityKey.get(communityKey) ?? [],
      ),
    }))
    .sort(
      (a, b) =>
        b.selectedItemCount - a.selectedItemCount ||
        a.communityRank - b.communityRank ||
        a.communityKey.localeCompare(b.communityKey),
    );
}

function summarizeFacets(
  runs: LandscapeReplayRun[],
  usageEventsByRunId: Map<string, UsageEventForReplay[]>,
): LandscapeFacetBasinSummary[] {
  const aggregateByFacet = new Map<
    string,
    {
      facetKind: LandscapeFacetBasinSummary["facetKind"];
      facetValue: string;
      runIds: Set<string>;
      selectedCommunityKeys: Set<string>;
      selectedItemCount: number;
      attractorHitCount: number;
      negativeCandidateHitCount: number;
      overSelectedHitCount: number;
      deadZoneMissCount: number;
      verdictMix: LandscapeVerdictMix;
      feedbackRunCount: number;
      acceptanceEvents: UsageEventForReplay[];
    }
  >();

  for (const run of runs) {
    const entries = enumerateLandscapeTaskFacetEntries(run.taskFacets);
    const runFeedbackCount = feedbackCount(run.verdicts);
    const selectedItemCount = run.basinTrace.reduce(
      (sum, trace) => sum + trace.selectedItemCount,
      0,
    );
    for (const entry of entries) {
      const key = `${entry.facetKind}:${entry.facetValue}`;
      const aggregate = aggregateByFacet.get(key) ?? {
        facetKind: entry.facetKind,
        facetValue: entry.facetValue,
        runIds: new Set<string>(),
        selectedCommunityKeys: new Set<string>(),
        selectedItemCount: 0,
        attractorHitCount: 0,
        negativeCandidateHitCount: 0,
        overSelectedHitCount: 0,
        deadZoneMissCount: 0,
        verdictMix: emptyVerdictMix(),
        feedbackRunCount: 0,
        acceptanceEvents: [],
      };
      aggregate.runIds.add(run.runId);
      aggregate.selectedItemCount += selectedItemCount;
      for (const trace of run.basinTrace) {
        if (trace.selectedItemCount > 0) aggregate.selectedCommunityKeys.add(trace.communityKey);
        if (trace.explanation === "aligned_attractor") aggregate.attractorHitCount += 1;
        if (trace.explanation === "negative_explained") aggregate.negativeCandidateHitCount += 1;
        if (trace.explanation === "over_selected") aggregate.overSelectedHitCount += 1;
        if (trace.explanation === "dead_zone_missed") aggregate.deadZoneMissCount += 1;
      }
      addVerdictMix(aggregate.verdictMix, run.verdicts);
      aggregate.acceptanceEvents.push(...(usageEventsByRunId.get(run.runId) ?? []));
      if (runFeedbackCount > 0) aggregate.feedbackRunCount += 1;
      aggregateByFacet.set(key, aggregate);
    }
  }

  return [...aggregateByFacet.values()]
    .map((aggregate) => {
      const totalFeedback = feedbackCount(aggregate.verdictMix);
      return {
        facetKind: aggregate.facetKind,
        facetValue: aggregate.facetValue,
        replayRunCount: aggregate.runIds.size,
        selectedItemCount: aggregate.selectedItemCount,
        selectedCommunityCount: aggregate.selectedCommunityKeys.size,
        attractorHitCount: aggregate.attractorHitCount,
        negativeCandidateHitCount: aggregate.negativeCandidateHitCount,
        overSelectedHitCount: aggregate.overSelectedHitCount,
        deadZoneMissCount: aggregate.deadZoneMissCount,
        usedRate: rate(aggregate.verdictMix.used, totalFeedback),
        offTopicRate: rate(aggregate.verdictMix.offTopic, totalFeedback),
        wrongRate: rate(aggregate.verdictMix.wrong, totalFeedback),
        feedbackCoverageRate: rate(aggregate.feedbackRunCount, aggregate.runIds.size),
        acceptanceWindow: buildAcceptanceWindowSummary(aggregate.acceptanceEvents),
      };
    })
    .sort(
      (a, b) =>
        b.negativeCandidateHitCount +
          b.overSelectedHitCount +
          b.deadZoneMissCount -
          (a.negativeCandidateHitCount + a.overSelectedHitCount + a.deadZoneMissCount) ||
        b.selectedItemCount - a.selectedItemCount ||
        a.facetKind.localeCompare(b.facetKind) ||
        a.facetValue.localeCompare(b.facetValue),
    );
}

function groupByRunId<T extends { runId: string }>(rows: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const rowsForRun = result.get(row.runId) ?? [];
    rowsForRun.push(row);
    result.set(row.runId, rowsForRun);
  }
  return result;
}

export async function buildLandscapeReplaySnapshot(
  input: BuildLandscapeReplaySnapshotInput,
): Promise<LandscapeReplaySnapshot> {
  return runWithLandscapeSnapshotCache({
    snapshotType: "landscape_replay_snapshot",
    params: {
      ...input,
    },
    build: async () => {
      const analysisDate = new Date();
      const analysisAsOf = analysisDate.toISOString();
      const corpusStartAt = new Date(
        analysisDate.getTime() - input.windowDays * 24 * 60 * 60 * 1000,
      );

      const [landscape, relationGraph, corpus] = await Promise.all([
        buildLandscapeSnapshot({
          windowDays: input.windowDays,
          limit: input.landscapeLimit,
          status: input.landscapeStatus,
          relationAxes: input.relationAxes,
          minSelectedCount: input.minSelectedCount,
          minFeedbackCount: input.minFeedbackCount,
        }),
        buildGraphSnapshot({
          limit: input.landscapeLimit,
          status: input.landscapeStatus,
          view: "community",
          relationAxes: input.relationAxes,
          communityDisplay: "detail",
        }),
        loadLandscapeReplayCorpus({
          windowDays: input.windowDays,
          limit: input.limit,
          runStatus: input.runStatus,
        }),
      ]);

      const communityByKey = new Map(
        landscape.communities.map((community) => [community.communityKey, community]),
      );
      const relationAssignmentsByKnowledgeId = new Map<string, RelationCommunityAssignment>();
      for (const node of relationGraph.nodes) {
        if (node.kind !== "knowledge" || !node.communityKey) continue;
        const community = communityByKey.get(node.communityKey);
        const knowledgeId = asKnowledgeNodeId(node.id);
        relationAssignmentsByKnowledgeId.set(knowledgeId, {
          knowledgeId,
          communityKey: node.communityKey,
          communityLabel: node.communityLabel ?? community?.communityLabel ?? node.communityKey,
          communityRank: node.communityRank ?? community?.communityRank ?? Number.MAX_SAFE_INTEGER,
          communitySize: node.communitySize ?? community?.size ?? 1,
          classificationAtAnalysis: community?.classification.primary ?? "neutral",
        });
      }

      const packItemsByRunId = groupByRunId(corpus.packItems);
      const usageEventsByRunId = groupByRunId(corpus.usageEvents);
      const selectedItemCountByKnowledgeId = new Map<string, number>();
      for (const item of corpus.packItems) {
        selectedItemCountByKnowledgeId.set(
          item.itemId,
          (selectedItemCountByKnowledgeId.get(item.itemId) ?? 0) + 1,
        );
      }
      const selectedKnowledgeIds = [...new Set(corpus.packItems.map((item) => item.itemId))];
      const comparison = await buildLandscapeCommunityComparison({
        knowledgeIds: [
          ...new Set([...selectedKnowledgeIds, ...relationAssignmentsByKnowledgeId.keys()]),
        ],
        relationAssignmentsByKnowledgeId,
        selectedItemCountByKnowledgeId,
        minSimilarity: input.minSimilarity,
        semanticTopK: input.semanticTopK,
      });
      const semanticDeadZonesByNeighborKnowledgeId = new Map<
        string,
        typeof comparison.communities
      >();
      for (const communityComparison of comparison.communities) {
        if (communityComparison.comparison !== "semantic_reachable_dead_zone") continue;
        for (const knowledgeId of communityComparison.selectedNeighborKnowledgeIds) {
          const existing = semanticDeadZonesByNeighborKnowledgeId.get(knowledgeId) ?? [];
          existing.push(communityComparison);
          semanticDeadZonesByNeighborKnowledgeId.set(knowledgeId, existing);
        }
      }

      const replayRuns: LandscapeReplayRun[] = [];
      const missingKnowledgeIds = new Set<string>();
      for (const run of corpus.runs) {
        const packItems = packItemsByRunId.get(run.id) ?? [];
        const rankByKnowledgeId = buildSelectedRankMap(packItems);
        const runSelectedKnowledgeIds = [...rankByKnowledgeId.keys()];
        const runSelectedCommunityKeys = new Set<string>();
        const runVerdicts = emptyVerdictMix();
        const usageEvents = usageEventsByRunId.get(run.id) ?? [];
        const usageEventsByKnowledgeId = new Map<string, UsageEventForReplay[]>();
        for (const event of usageEvents) {
          incrementVerdict(runVerdicts, event.verdict);
          const events = usageEventsByKnowledgeId.get(event.knowledgeId) ?? [];
          events.push(event);
          usageEventsByKnowledgeId.set(event.knowledgeId, events);
        }

        const selectedKnowledgeIdsByCommunityKey = new Map<string, string[]>();
        for (const knowledgeId of runSelectedKnowledgeIds) {
          const assignment = relationAssignmentsByKnowledgeId.get(knowledgeId);
          if (!assignment) {
            missingKnowledgeIds.add(knowledgeId);
            continue;
          }
          runSelectedCommunityKeys.add(assignment.communityKey);
          const communityKnowledgeIds =
            selectedKnowledgeIdsByCommunityKey.get(assignment.communityKey) ?? [];
          communityKnowledgeIds.push(knowledgeId);
          selectedKnowledgeIdsByCommunityKey.set(assignment.communityKey, communityKnowledgeIds);
        }

        const basinTrace: LandscapeBasinTrace[] = [];
        for (const [communityKey, communityKnowledgeIds] of selectedKnowledgeIdsByCommunityKey) {
          const firstKnowledgeId = communityKnowledgeIds[0];
          if (!firstKnowledgeId) continue;
          const assignment = relationAssignmentsByKnowledgeId.get(firstKnowledgeId);
          if (!assignment) continue;
          const verdictMix = emptyVerdictMix();
          const selectedRanks: number[] = [];
          for (const knowledgeId of communityKnowledgeIds) {
            const rank = rankByKnowledgeId.get(knowledgeId);
            if (rank) selectedRanks.push(rank);
            for (const event of usageEventsByKnowledgeId.get(knowledgeId) ?? []) {
              incrementVerdict(verdictMix, event.verdict);
            }
          }
          basinTrace.push(
            buildCommunityTrace({
              assignment,
              community: communityByKey.get(communityKey),
              selectedItemCount: communityKnowledgeIds.length,
              selectedRanks,
              verdictMix,
            }),
          );
        }

        const existingTraceKeys = new Set(basinTrace.map((trace) => trace.communityKey));
        for (const knowledgeId of runSelectedKnowledgeIds) {
          for (const deadZoneComparison of semanticDeadZonesByNeighborKnowledgeId.get(
            knowledgeId,
          ) ?? []) {
            if (existingTraceKeys.has(deadZoneComparison.relationCommunityKey)) continue;
            const community = communityByKey.get(deadZoneComparison.relationCommunityKey);
            basinTrace.push({
              communityKey: deadZoneComparison.relationCommunityKey,
              communityLabel: deadZoneComparison.relationCommunityLabel,
              communityRank: deadZoneComparison.relationCommunityRank,
              selectedItemCount: 0,
              selectedRanks: [],
              classificationAtAnalysis:
                community?.classification.primary ?? "dead_zone_reachability_risk",
              classificationConfidenceAtAnalysis: asClassificationConfidence(
                community?.classification.confidence,
              ),
              feedbackConfidenceAtAnalysis: asFeedbackConfidence(
                community?.feedback.feedbackConfidence,
              ),
              verdictMix: emptyVerdictMix(),
              explanation: "dead_zone_missed",
            });
            existingTraceKeys.add(deadZoneComparison.relationCommunityKey);
          }
        }

        const taskFacets = extractLandscapeTaskFacets({
          runInput: run.input,
          repoPath: run.repoPath,
          retrievalMode: run.retrievalMode,
          source: run.source,
          runStatus: run.status,
          degradedReasons: run.degradedReasons,
        });
        replayRuns.push({
          runId: run.id,
          createdAt: run.createdAt.toISOString(),
          goal: run.goal,
          retrievalMode: run.retrievalMode,
          status: run.status,
          source: run.source,
          taskFacets,
          selectedKnowledgeIds: runSelectedKnowledgeIds,
          selectedCommunityKeys: [...runSelectedCommunityKeys].sort(),
          missingKnowledgeIds: runSelectedKnowledgeIds.filter(
            (knowledgeId) => !relationAssignmentsByKnowledgeId.has(knowledgeId),
          ),
          verdicts: runVerdicts,
          basinTrace: basinTrace.sort(
            (a, b) =>
              a.communityRank - b.communityRank ||
              b.selectedItemCount - a.selectedItemCount ||
              a.communityKey.localeCompare(b.communityKey),
          ),
        });
      }

      const eventsWithRunId = corpus.usageEvents.map((event) => ({
        runId: event.runId,
        knowledgeId: event.knowledgeId,
        verdict: event.verdict,
        actor: event.actor,
        metadata: event.metadata,
      }));
      const acceptanceEventsByRunId = groupByRunId(eventsWithRunId);
      const acceptanceEventsByCommunityKey = new Map<string, UsageEventForReplay[]>();
      for (const event of eventsWithRunId) {
        const assignment = relationAssignmentsByKnowledgeId.get(event.knowledgeId);
        if (!assignment) continue;
        const events = acceptanceEventsByCommunityKey.get(assignment.communityKey) ?? [];
        events.push(event);
        acceptanceEventsByCommunityKey.set(assignment.communityKey, events);
      }

      return {
        generatedAt: analysisAsOf,
        analysisAsOf,
        windowDays: input.windowDays,
        corpusWindow: {
          startAt: corpusStartAt.toISOString(),
          endAt: analysisAsOf,
        },
        landscapeWindow: {
          days: input.windowDays,
          analysisAsOf,
        },
        basis: {
          unit: "community-replay",
          relationAxes: input.relationAxes,
          runStatus: input.runStatus,
          landscapeStatus: input.landscapeStatus,
          minSimilarity: input.minSimilarity,
          semanticTopK: input.semanticTopK,
        },
        replayRunCount: replayRuns.length,
        selectedKnowledgeCount: selectedKnowledgeIds.length,
        missingKnowledgeCount: missingKnowledgeIds.size,
        runs: input.includeRuns ? replayRuns : [],
        facetSummaries: summarizeFacets(replayRuns, acceptanceEventsByRunId),
        communityReplaySummaries: summarizeReplayCommunities(
          replayRuns,
          acceptanceEventsByCommunityKey,
        ),
        acceptanceWindow: buildAcceptanceWindowSummary(eventsWithRunId),
        communityComparison: comparison,
      };
    },
  });
}
