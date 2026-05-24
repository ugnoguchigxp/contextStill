import type {
  LandscapeClassificationConfidence,
  LandscapeClassificationPrimary,
  LandscapeFeedbackConfidence,
  LandscapeGraphRelationAxis,
  LandscapeGraphStatusFilter,
} from "./landscape.types.js";

export type LandscapeRunStatus = "ok" | "degraded" | "failed";
export type LandscapeRunStatusFilter = LandscapeRunStatus | "all";

export type LandscapeUsageVerdict = "used" | "not_used" | "off_topic" | "wrong";
export type LandscapeFeedbackActor = "agent" | "user" | "system";

export type LandscapeVerdictMix = {
  used: number;
  notUsed: number;
  offTopic: number;
  wrong: number;
};

export type LandscapeTaskFacetKind =
  | "retrievalMode"
  | "repoKey"
  | "technology"
  | "changeType"
  | "domain"
  | "source"
  | "runStatus"
  | "degradedReasonBucket";

export type LandscapeTaskFacetEntry = {
  facetKind: LandscapeTaskFacetKind;
  facetValue: string;
};

export type LandscapeTaskFacets = {
  repoKey?: string;
  repoPath?: string;
  retrievalMode: string;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  source: string;
  runStatus: LandscapeRunStatus;
  degradedReasonBuckets: string[];
};

export type LandscapeBasinExplanation =
  | "aligned_attractor"
  | "negative_explained"
  | "dead_zone_missed"
  | "over_selected"
  | "unexplained";

export type LandscapeBasinTrace = {
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  selectedItemCount: number;
  selectedRanks: number[];
  classificationAtAnalysis: LandscapeClassificationPrimary;
  classificationConfidenceAtAnalysis: LandscapeClassificationConfidence;
  feedbackConfidenceAtAnalysis: LandscapeFeedbackConfidence;
  verdictMix: LandscapeVerdictMix;
  explanation: LandscapeBasinExplanation;
};

export type LandscapeReplayRun = {
  runId: string;
  createdAt: string;
  goal: string;
  retrievalMode: string;
  status: LandscapeRunStatus;
  source: string;
  taskFacets: LandscapeTaskFacets;
  selectedKnowledgeIds: string[];
  selectedCommunityKeys: string[];
  missingKnowledgeIds: string[];
  verdicts: LandscapeVerdictMix;
  basinTrace: LandscapeBasinTrace[];
};

export type LandscapeFacetBasinSummary = {
  facetKind: LandscapeTaskFacetKind;
  facetValue: string;
  replayRunCount: number;
  selectedItemCount: number;
  selectedCommunityCount: number;
  attractorHitCount: number;
  negativeCandidateHitCount: number;
  overSelectedHitCount: number;
  deadZoneMissCount: number;
  usedRate: number;
  offTopicRate: number;
  wrongRate: number;
  feedbackCoverageRate: number;
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
};

export type LandscapeCommunityReplaySummary = {
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  replayRunCount: number;
  selectedItemCount: number;
  classificationAtAnalysis: LandscapeClassificationPrimary;
  verdictMix: LandscapeVerdictMix;
  explanationCounts: Record<LandscapeBasinExplanation, number>;
  feedbackCoverageRate: number;
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
};

export type LandscapeAcceptanceWindowSummary = {
  eventCountWindow: number;
  acceptedCountWindow: number;
  acceptedRunCountWindow: number;
  unknownAcceptanceCountWindow: number;
  agentActorEventCountWindow: number;
  acceptanceRateKnownWindow: number;
  acceptanceCoverageRate: number;
};

export type LandscapeCommunityComparisonKind =
  | "aligned"
  | "semantic_split"
  | "semantic_merge"
  | "relation_orphan"
  | "semantic_reachable_dead_zone";

export type LandscapeCommunityComparison = {
  relationCommunityKey: string;
  relationCommunityLabel: string;
  relationCommunityRank: number;
  semanticCommunityKey?: string;
  comparison: LandscapeCommunityComparisonKind;
  jaccardOverlap: number;
  relationCommunitySize: number;
  semanticCommunitySize: number;
  selectedNeighborCountWindow: number;
  selectedNeighborKnowledgeIds: string[];
  deadZoneSemanticReachabilityScore: number;
};

export type LandscapeCommunityComparisonSummary = {
  universeKnowledgeCount: number;
  comparedKnowledgeCount: number;
  missingRelationAssignmentCount: number;
  missingSemanticAssignmentCount: number;
  alignedCount: number;
  semanticSplitCount: number;
  semanticMergeCount: number;
  relationOrphanCount: number;
  semanticReachableDeadZoneCount: number;
  communities: LandscapeCommunityComparison[];
};

export type LandscapeReplaySnapshot = {
  generatedAt: string;
  analysisAsOf: string;
  windowDays: number;
  corpusWindow: {
    startAt: string;
    endAt: string;
  };
  landscapeWindow: {
    days: number;
    analysisAsOf: string;
  };
  basis: {
    unit: "community-replay";
    relationAxes: LandscapeGraphRelationAxis[];
    runStatus: LandscapeRunStatusFilter;
    landscapeStatus: LandscapeGraphStatusFilter;
    minSimilarity: number;
    semanticTopK: number;
  };
  replayRunCount: number;
  selectedKnowledgeCount: number;
  missingKnowledgeCount: number;
  runs: LandscapeReplayRun[];
  facetSummaries: LandscapeFacetBasinSummary[];
  communityReplaySummaries: LandscapeCommunityReplaySummary[];
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
  communityComparison: LandscapeCommunityComparisonSummary;
};

export type BuildLandscapeReplaySnapshotInput = {
  windowDays: number;
  limit: number;
  landscapeLimit: number;
  runStatus: LandscapeRunStatusFilter;
  landscapeStatus: LandscapeGraphStatusFilter;
  relationAxes: LandscapeGraphRelationAxis[];
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  includeRuns: boolean;
};
