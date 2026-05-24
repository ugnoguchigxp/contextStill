import { z } from "zod";
import { landscapeRunStatusSchema } from "./landscape-replay.schema.js";

export const landscapeTrajectoryCandidateSchema = z.object({
  itemKind: z.enum(["rule", "procedure"]),
  itemId: z.string().min(1),
  textRank: z.number().int().positive().nullable(),
  textScore: z.number().nullable(),
  vectorRank: z.number().int().positive().nullable(),
  vectorScore: z.number().nullable(),
  mergedRank: z.number().int().positive().nullable(),
  mergedScore: z.number().nullable(),
  finalRank: z.number().int().positive().nullable(),
  finalScore: z.number().nullable(),
  selected: z.boolean(),
  suppressed: z.boolean(),
  suppressionReason: z.string().nullable(),
  agenticDecision: z.enum(["not_evaluated", "accepted", "rejected", "skipped"]),
  rankingReason: z.string().nullable(),
  communityKey: z.string().nullable(),
  evidence: z.object({
    status: z.string().nullable(),
    candidateEvidence: z
      .object({
        textMatched: z.boolean(),
        vectorMatched: z.boolean(),
        vectorScore: z.number().nullable().optional(),
        facetMatched: z.boolean(),
      })
      .nullable(),
  }),
});

export const landscapeTrajectoryStageCountsSchema = z.object({
  totalCandidates: z.number().int().nonnegative(),
  textHit: z.number().int().nonnegative(),
  vectorHit: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  finalRanked: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
});

export const landscapeTrajectoryCommunitySummarySchema = z.object({
  communityKey: z.string().min(1),
  candidateCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  suppressedCount: z.number().int().nonnegative(),
});

export const landscapeTrajectoryDiagnosticsSchema = z.object({
  candidateTraceSavedCount: z.number().int().nonnegative().nullable(),
  candidateTraceTruncated: z.boolean().nullable(),
  candidateTraceLimit: z.number().int().positive().nullable(),
  candidateTraceSkippedReason: z.string().nullable(),
});

export const landscapeTrajectoryTaskTraceSchema = z.object({
  runId: z.string().min(1),
  retrievalMode: z.string().min(1),
  repoPath: z.string().nullable(),
  repoKey: z.string().nullable(),
  technologies: z.array(z.string()),
  changeTypes: z.array(z.string()),
  domains: z.array(z.string()),
  embeddingStatus: z.enum(["facets_only", "embedding_available", "embedding_unavailable"]),
  embeddingProvider: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  embeddingDimensions: z.number().int().positive().nullable(),
  goalHash: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const landscapeTrajectoryTaskSimilaritySchema = z.object({
  runId: z.string().min(1),
  similarity: z.number().min(0).max(1),
  mode: z.enum(["embedding", "facets"]),
  retrievalMode: z.string().min(1),
  repoPath: z.string().nullable(),
  repoKey: z.string().nullable(),
  goalHash: z.string().min(1),
  embeddingStatus: z.enum(["facets_only", "embedding_available", "embedding_unavailable"]),
  createdAt: z.string().datetime(),
});

export const landscapeTrajectoryResultSchema = z.object({
  run: z.object({
    id: z.string().min(1),
    goal: z.string(),
    retrievalMode: z.string(),
    status: landscapeRunStatusSchema,
    source: z.string(),
    createdAt: z.string().datetime(),
  }),
  traceAvailable: z.boolean(),
  warnings: z.array(z.string()),
  stageCounts: landscapeTrajectoryStageCountsSchema,
  selectedKnowledgeIds: z.array(z.string()),
  diagnostics: landscapeTrajectoryDiagnosticsSchema,
  candidates: z.array(landscapeTrajectoryCandidateSchema),
  communitySummary: z.array(landscapeTrajectoryCommunitySummarySchema),
  taskTrace: landscapeTrajectoryTaskTraceSchema.nullable(),
  taskSimilarity: z.array(landscapeTrajectoryTaskSimilaritySchema),
});

export const landscapeTrajectoryQuerySchema = z.object({
  includeCandidates: z.preprocess((value) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return value;
  }, z.boolean().default(true)),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

export type LandscapeTrajectoryResult = z.infer<typeof landscapeTrajectoryResultSchema>;
export type LandscapeTrajectoryCandidate = z.infer<typeof landscapeTrajectoryCandidateSchema>;
export type LandscapeTrajectoryQuery = z.infer<typeof landscapeTrajectoryQuerySchema>;
