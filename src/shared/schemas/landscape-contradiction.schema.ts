import { z } from "zod";
import { landscapeRelationAxisSchema, landscapeStatusFilterSchema } from "./landscape.schema.js";

export const landscapeContradictionDetectionInputSchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  knowledgeLimit: z.coerce.number().int().min(20).max(500).default(180),
  candidateLimit: z.coerce.number().int().min(1).max(500).default(120),
  landscapeStatus: landscapeStatusFilterSchema.default("all"),
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
  semanticMinSimilarity: z.coerce.number().min(0).max(1).default(0.82),
  confidenceThreshold: z.coerce.number().min(0).max(1).default(0.62),
  recentSelectionMin: z.coerce.number().int().min(0).max(50).default(2),
});

export const landscapeContradictionScopeOverlapSchema = z.object({
  repoPath: z.boolean(),
  repoKey: z.boolean(),
  technologies: z.array(z.string()),
  changeTypes: z.array(z.string()),
  domains: z.array(z.string()),
});

export const landscapeContradictionCandidateSchema = z.object({
  pairKey: z.string().min(1),
  leftKnowledgeId: z.string().min(1),
  rightKnowledgeId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  confidenceLabel: z.enum(["low", "medium", "high"]),
  priority: z.number().int().min(0).max(100),
  relationNeighbor: z.boolean(),
  semanticNeighbor: z.boolean(),
  scopeOverlap: landscapeContradictionScopeOverlapSchema,
  sharedConceptTokens: z.array(z.string()),
  leftMarkers: z.array(z.string()),
  rightMarkers: z.array(z.string()),
  leftSnippet: z.string(),
  rightSnippet: z.string(),
  communityKey: z.string().nullable(),
  communityLabel: z.string().nullable(),
  evidence: z.array(z.string()),
  payload: z.record(z.unknown()),
});

export type LandscapeContradictionDetectionInput = z.infer<
  typeof landscapeContradictionDetectionInputSchema
>;
export type LandscapeContradictionCandidate = z.infer<typeof landscapeContradictionCandidateSchema>;
