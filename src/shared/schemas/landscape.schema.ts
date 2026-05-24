import { z } from "zod";

export const landscapeRelationAxisSchema = z.enum(["session", "project", "source"]);
export const landscapeStatusFilterSchema = z.enum([
  "current",
  "active",
  "draft",
  "deprecated",
  "all",
]);

export const landscapeFeedbackConfidenceSchema = z.enum(["insufficient", "low", "medium", "high"]);

export const landscapeClassificationPrimarySchema = z.enum([
  "strong_attractor",
  "useful_attractor",
  "negative_attractor_candidate",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
  "feedback_insufficient",
  "neutral",
]);

export const landscapeClassificationConfidenceSchema = z.enum(["low", "medium", "high"]);

export const landscapeRiskTypeSchema = z.enum([
  "negative_attractor_candidate",
  "wrong_review_required",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
]);

export const landscapeThresholdsSchema = z.object({
  minSelectedCount: z.number().int().nonnegative(),
  minFeedbackCount: z.number().int().nonnegative(),
  feedbackConfidence: z.object({
    mediumMin: z.number().int().nonnegative(),
    highMin: z.number().int().nonnegative(),
  }),
  feedbackFactor: z.object({
    insufficient: z.number(),
    low: z.number(),
    medium: z.number(),
    high: z.number(),
  }),
  attractor: z.object({
    strongUsedRateMin: z.number(),
    usefulUsedRateMin: z.number(),
    strongSourceRefDensityMin: z.number(),
  }),
  negative: z.object({
    offTopicWeight: z.number(),
    wrongWeight: z.number(),
    candidateOffTopicRateMin: z.number(),
  }),
  notUsed: z.object({
    overSelectedRateMin: z.number(),
  }),
  deadZone: z.object({
    reachabilityRiskMin: z.number(),
    staleSourceRefDensityMax: z.number(),
    staleFactorMin: z.number(),
  }),
  evidenceFactor: z.object({
    sourceRefDensityBaseline: z.number(),
    min: z.number(),
    max: z.number(),
  }),
});

export const landscapeCommunitySchema = z.object({
  communityId: z.string().min(1),
  communityKey: z.string().min(1),
  communityLabel: z.string().min(1),
  communityRank: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  memberCounts: z.object({
    active: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    deprecated: z.number().int().nonnegative(),
    rule: z.number().int().nonnegative(),
    procedure: z.number().int().nonnegative(),
    embedded: z.number().int().nonnegative(),
  }),
  selection: z.object({
    selectedItemCountWindow: z.number().int().nonnegative(),
    selectedRunCountWindow: z.number().int().nonnegative(),
    cumulativeCompileSelectCount: z.number().int().nonnegative(),
    zeroUseActiveCount: z.number().int().nonnegative(),
    zeroUseActiveRatio: z.number().nonnegative(),
  }),
  feedback: z.object({
    usedCountWindow: z.number().int().nonnegative(),
    notUsedCountWindow: z.number().int().nonnegative(),
    offTopicCountWindow: z.number().int().nonnegative(),
    wrongCountWindow: z.number().int().nonnegative(),
    feedbackCountWindow: z.number().int().nonnegative(),
    usedRate: z.number().nonnegative(),
    notUsedRate: z.number().nonnegative(),
    offTopicRate: z.number().nonnegative(),
    wrongRate: z.number().nonnegative(),
    feedbackConfidence: landscapeFeedbackConfidenceSchema,
  }),
  quality: z.object({
    avgImportance: z.number(),
    avgConfidence: z.number(),
    avgDynamicScore: z.number(),
    sourceRefCount: z.number().int().nonnegative(),
    sourceRefDensity: z.number().nonnegative(),
    avgFreshnessFactor: z.number().nonnegative(),
    avgStalenessFactor: z.number().nonnegative(),
  }),
  scores: z.object({
    activity: z.number().int().nonnegative(),
    attractorScore: z.number().nonnegative(),
    negativeScore: z.number().nonnegative(),
    reachabilityRiskScore: z.number().nonnegative(),
  }),
  classification: z.object({
    primary: landscapeClassificationPrimarySchema,
    flags: z.array(z.string()),
    confidence: landscapeClassificationConfidenceSchema,
    reason: z.string(),
  }),
  recommendedActions: z.array(z.string()),
  representativeKnowledgeIds: z.array(z.string()),
});

export const landscapeRiskSchema = z.object({
  communityId: z.string().min(1),
  communityKey: z.string().min(1),
  communityLabel: z.string().min(1),
  communityRank: z.number().int().nonnegative(),
  type: landscapeRiskTypeSchema,
  severity: landscapeClassificationConfidenceSchema,
  reason: z.string(),
});

export const landscapeStatsSchema = z.object({
  totalCommunities: z.number().int().nonnegative(),
  activeCommunities: z.number().int().nonnegative(),
  selectedCommunities: z.number().int().nonnegative(),
  insufficientFeedbackCommunities: z.number().int().nonnegative(),
  strongAttractorCount: z.number().int().nonnegative(),
  usefulAttractorCount: z.number().int().nonnegative(),
  negativeCandidateCount: z.number().int().nonnegative(),
  overSelectedNotUsedCount: z.number().int().nonnegative(),
  deadZoneReachabilityCount: z.number().int().nonnegative(),
  deadZoneStaleCount: z.number().int().nonnegative(),
});

export const landscapeSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  windowDays: z.number().int().min(1).max(180),
  basis: z.object({
    unit: z.literal("community"),
    relationAxes: z.array(landscapeRelationAxisSchema),
    status: landscapeStatusFilterSchema,
  }),
  thresholds: landscapeThresholdsSchema,
  stats: landscapeStatsSchema,
  communities: z.array(landscapeCommunitySchema),
  risks: z.array(landscapeRiskSchema),
});

export type LandscapeSnapshot = z.infer<typeof landscapeSnapshotSchema>;
