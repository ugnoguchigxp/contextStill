import { z } from "zod";
import {
  landscapeClassificationConfidenceSchema,
  landscapeRelationAxisSchema,
  landscapeStatusFilterSchema,
} from "./landscape.schema.js";

export const deadZoneKnowledgeReviewReasonSchema = z.enum([
  "all",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
]);

export const deadZoneKnowledgeReviewBadgeSchema = z.enum([
  "Strong merge candidate",
  "Canonical candidate",
  "Likely duplicate",
  "Scope differs",
  "Evidence thin",
  "Stale",
  "Niche but valid",
  "Needs embedding",
  "Similarity unavailable",
]);

export const deadZoneEvidenceStrengthSchema = z.enum(["none", "thin", "moderate", "strong"]);
export const deadZoneUsageStrengthSchema = z.enum(["none", "low", "moderate", "strong"]);
export const deadZoneStructureQualitySchema = z.enum(["weak", "partial", "strong"]);
export const deadZoneGraphHealthSchema = z.enum(["orphan", "thin", "connected"]);
export const deadZoneApplicabilityMatchSchema = z.enum(["low", "medium", "high"]);
export const deadZoneSuggestedActionSchema = z.enum([
  "merge_into_similar",
  "deadzone_is_canonical",
  "likely_duplicate",
  "scope_differs",
  "needs_evidence",
  "keep_separate",
]);

export const deadZoneKnowledgeReviewQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
  status: landscapeStatusFilterSchema.default("active"),
  reason: deadZoneKnowledgeReviewReasonSchema.default("all"),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.9),
  similarTopK: z.coerce.number().int().min(1).max(10).default(5),
  relationAxes: z.preprocess(
    (value) => {
      if (typeof value === "string") {
        return value
          .split(",")
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
      }
      return value;
    },
    z.array(landscapeRelationAxisSchema).min(1).default(["session", "project", "source"]),
  ),
  communityKey: z.string().trim().min(1).optional(),
  badge: z.union([deadZoneKnowledgeReviewBadgeSchema, z.literal("all")]).default("all"),
  sortBy: z
    .enum(["deadZoneScore", "compileSelectCount", "title", "similarity", "evidence", "usage"])
    .default("deadZoneScore"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const deadZoneKnowledgeMaintenanceActionSchema = z.enum([
  "merge_deadzone_into_similar",
  "merge_similar_into_deadzone",
  "deprecate_deadzone",
  "deprecate_similar",
]);

export const deadZoneKnowledgeMaintenanceInputSchema = z.object({
  action: deadZoneKnowledgeMaintenanceActionSchema,
  deadZoneKnowledgeId: z.string().trim().min(1),
  similarKnowledgeId: z.string().trim().min(1).optional(),
});

export const deadZoneKnowledgeMaintenanceResultSchema = z.object({
  action: deadZoneKnowledgeMaintenanceActionSchema,
  keptKnowledgeId: z.string().nullable(),
  deprecatedKnowledgeId: z.string(),
});

export const deadZoneKnowledgeSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  bodyPreview: z.string(),
  type: z.enum(["rule", "procedure"]),
  status: z.enum(["draft", "active", "deprecated"]),
  appliesTo: z.record(z.unknown()),
  confidence: z.number(),
  importance: z.number(),
  compileSelectCount: z.number().int().nonnegative(),
  lastCompiledAt: z.string().datetime().nullable(),
  sourceRefCount: z.number().int().nonnegative(),
  sourceRefDensity: z.number().nonnegative(),
  communityKey: z.string().nullable(),
  communityLabel: z.string().nullable(),
});

export const deadZoneKnowledgeIndicatorsSchema = z.object({
  deadZoneScore: z.number().int().min(0).max(100),
  evidenceStrength: deadZoneEvidenceStrengthSchema,
  usageStrength: deadZoneUsageStrengthSchema,
  structureQuality: deadZoneStructureQualitySchema,
  graphHealth: deadZoneGraphHealthSchema,
  badges: z.array(deadZoneKnowledgeReviewBadgeSchema),
});

export const deadZoneSimilarKnowledgeSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["draft", "active", "deprecated"]),
  similarity: z.number().min(0).max(1),
  applicabilityMatch: deadZoneApplicabilityMatchSchema,
  evidenceStrength: deadZoneEvidenceStrengthSchema,
  usageStrength: deadZoneUsageStrengthSchema,
  suggestedAction: deadZoneSuggestedActionSchema,
  reasons: z.array(z.string()),
});

export const deadZoneKnowledgeReviewItemSchema = z.object({
  knowledge: deadZoneKnowledgeSummarySchema,
  classification: z.object({
    primary: z.enum(["dead_zone_reachability_risk", "dead_zone_stale"]),
    confidence: landscapeClassificationConfidenceSchema,
    reason: z.string(),
  }),
  indicators: deadZoneKnowledgeIndicatorsSchema,
  similarKnowledge: z.array(deadZoneSimilarKnowledgeSchema),
  reviewItemId: z.string().nullable(),
});

export const deadZoneKnowledgeReviewResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  windowDays: z.number().int().min(1).max(180),
  minSimilarity: z.number().min(0).max(1),
  similarTopK: z.number().int().min(1).max(10),
  communityCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  unavailableReason: z.string().nullable(),
  items: z.array(deadZoneKnowledgeReviewItemSchema),
});

export type DeadZoneKnowledgeReviewQuery = z.input<typeof deadZoneKnowledgeReviewQuerySchema>;
export type DeadZoneKnowledgeMaintenanceAction = z.infer<
  typeof deadZoneKnowledgeMaintenanceActionSchema
>;
export type DeadZoneKnowledgeMaintenanceInput = z.infer<
  typeof deadZoneKnowledgeMaintenanceInputSchema
>;
export type DeadZoneKnowledgeMaintenanceResult = z.infer<
  typeof deadZoneKnowledgeMaintenanceResultSchema
>;
export type DeadZoneKnowledgeReviewBadge = z.infer<typeof deadZoneKnowledgeReviewBadgeSchema>;
export type DeadZoneEvidenceStrength = z.infer<typeof deadZoneEvidenceStrengthSchema>;
export type DeadZoneUsageStrength = z.infer<typeof deadZoneUsageStrengthSchema>;
export type DeadZoneStructureQuality = z.infer<typeof deadZoneStructureQualitySchema>;
export type DeadZoneGraphHealth = z.infer<typeof deadZoneGraphHealthSchema>;
export type DeadZoneApplicabilityMatch = z.infer<typeof deadZoneApplicabilityMatchSchema>;
export type DeadZoneSuggestedAction = z.infer<typeof deadZoneSuggestedActionSchema>;
export type DeadZoneKnowledgeSummary = z.infer<typeof deadZoneKnowledgeSummarySchema>;
export type DeadZoneKnowledgeIndicators = z.infer<typeof deadZoneKnowledgeIndicatorsSchema>;
export type DeadZoneSimilarKnowledge = z.infer<typeof deadZoneSimilarKnowledgeSchema>;
export type DeadZoneKnowledgeReviewItem = z.infer<typeof deadZoneKnowledgeReviewItemSchema>;
export type DeadZoneKnowledgeReviewResponse = z.infer<typeof deadZoneKnowledgeReviewResponseSchema>;
