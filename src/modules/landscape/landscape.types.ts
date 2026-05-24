export type LandscapeGraphRelationAxis = "session" | "project" | "source";
export type LandscapeGraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

export type LandscapeFeedbackConfidence = "insufficient" | "low" | "medium" | "high";

export type LandscapeClassificationPrimary =
  | "strong_attractor"
  | "useful_attractor"
  | "negative_attractor_candidate"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale"
  | "feedback_insufficient"
  | "neutral";

export type LandscapeClassificationConfidence = "low" | "medium" | "high";

export type LandscapeRiskType =
  | "negative_attractor_candidate"
  | "wrong_review_required"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale";

export type LandscapeThresholds = {
  minSelectedCount: number;
  minFeedbackCount: number;
  feedbackConfidence: {
    mediumMin: number;
    highMin: number;
  };
  feedbackFactor: Record<LandscapeFeedbackConfidence, number>;
  attractor: {
    strongUsedRateMin: number;
    usefulUsedRateMin: number;
    strongSourceRefDensityMin: number;
  };
  negative: {
    offTopicWeight: number;
    wrongWeight: number;
    candidateOffTopicRateMin: number;
  };
  notUsed: {
    overSelectedRateMin: number;
  };
  deadZone: {
    reachabilityRiskMin: number;
    staleSourceRefDensityMax: number;
    staleFactorMin: number;
  };
  evidenceFactor: {
    sourceRefDensityBaseline: number;
    min: number;
    max: number;
  };
};

export type LandscapeStats = {
  totalCommunities: number;
  activeCommunities: number;
  selectedCommunities: number;
  insufficientFeedbackCommunities: number;
  strongAttractorCount: number;
  usefulAttractorCount: number;
  negativeCandidateCount: number;
  overSelectedNotUsedCount: number;
  deadZoneReachabilityCount: number;
  deadZoneStaleCount: number;
};

export type LandscapeCommunity = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;

  memberCounts: {
    active: number;
    draft: number;
    deprecated: number;
    rule: number;
    procedure: number;
    embedded: number;
  };

  selection: {
    selectedItemCountWindow: number;
    selectedRunCountWindow: number;
    cumulativeCompileSelectCount: number;
    zeroUseActiveCount: number;
    zeroUseActiveRatio: number;
  };

  feedback: {
    usedCountWindow: number;
    notUsedCountWindow: number;
    offTopicCountWindow: number;
    wrongCountWindow: number;
    feedbackCountWindow: number;
    usedRate: number;
    notUsedRate: number;
    offTopicRate: number;
    wrongRate: number;
    feedbackConfidence: LandscapeFeedbackConfidence;
  };

  quality: {
    avgImportance: number;
    avgConfidence: number;
    avgDynamicScore: number;
    sourceRefCount: number;
    sourceRefDensity: number;
    avgFreshnessFactor: number;
    avgStalenessFactor: number;
  };

  scores: {
    activity: number;
    attractorScore: number;
    negativeScore: number;
    reachabilityRiskScore: number;
  };

  classification: {
    primary: LandscapeClassificationPrimary;
    flags: string[];
    confidence: LandscapeClassificationConfidence;
    reason: string;
  };

  recommendedActions: string[];
  representativeKnowledgeIds: string[];
};

export type LandscapeRisk = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  type: LandscapeRiskType;
  severity: LandscapeClassificationConfidence;
  reason: string;
};

export type LandscapeSnapshot = {
  generatedAt: string;
  windowDays: number;
  basis: {
    unit: "community";
    relationAxes: LandscapeGraphRelationAxis[];
    status: LandscapeGraphStatusFilter;
  };
  thresholds: LandscapeThresholds;
  stats: LandscapeStats;
  communities: LandscapeCommunity[];
  risks: LandscapeRisk[];
};

export type BuildLandscapeSnapshotInput = {
  windowDays: number;
  limit: number;
  status: LandscapeGraphStatusFilter;
  relationAxes: LandscapeGraphRelationAxis[];
  minSelectedCount: number;
  minFeedbackCount: number;
};
