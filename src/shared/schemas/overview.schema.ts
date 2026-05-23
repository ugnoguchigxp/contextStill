import { z } from "zod";

const dayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const overviewKnowledgeStatusSchema = z.enum(["active", "draft", "deprecated"]);
export const overviewDynamicScoreBucketSchema = z.enum([
  "0",
  "0-1",
  "1-5",
  "5-10",
  "10-15",
  "15-20",
  "20-25",
  "25-30",
  "30-35",
  "35+",
]);
export const overviewSourceCoverageLabelSchema = z.enum(["linked", "unlinked"]);
export const overviewCommunitySourceCoverageLabelSchema = z.enum([
  "covered",
  "thin",
  "no-source",
]);
export const overviewDistillationTargetKindSchema = z.enum([
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
]);
export const overviewSearchApiStatusSchema = z.enum(["ok", "cooldown"]);

export const overviewDashboardSchema = z.object({
  checkedAt: z.string().datetime(),
  kpis: z.object({
    knowledgeTotal: z.number().int().nonnegative(),
    activeKnowledge: z.number().int().nonnegative(),
    draftKnowledge: z.number().int().nonnegative(),
    deprecatedKnowledge: z.number().int().nonnegative(),
    rules: z.number().int().nonnegative(),
    procedures: z.number().int().nonnegative(),
    embeddedKnowledge: z.number().int().nonnegative(),
    zeroUseActiveKnowledge: z.number().int().nonnegative(),
    wikiPages: z.number().int().nonnegative(),
    indexedSources: z.number().int().nonnegative(),
    sourceFragments: z.number().int().nonnegative(),
    sourceLinks: z.number().int().nonnegative(),
    linkedKnowledge: z.number().int().nonnegative(),
    unlinkedKnowledge: z.number().int().nonnegative(),
    sourceCommunities: z.number().int().nonnegative(),
    sourceCoveredCommunities: z.number().int().nonnegative(),
    sourceThinCommunities: z.number().int().nonnegative(),
    sourceMissingCommunities: z.number().int().nonnegative(),
    vibeRecords: z.number().int().nonnegative(),
    vibeSessions: z.number().int().nonnegative(),
    vibeRecordsWithDiffs: z.number().int().nonnegative(),
    agentDiffEntries: z.number().int().nonnegative(),
    compileRuns: z.number().int().nonnegative(),
    compileOkRuns: z.number().int().nonnegative(),
    compileDegradedRuns: z.number().int().nonnegative(),
    compileFailedRuns: z.number().int().nonnegative(),
    graphNodes: z.number().int().nonnegative().optional(),
    graphEdges: z.number().int().nonnegative().optional(),
    graphEmbedded: z.number().int().nonnegative().optional(),
    graphSessionEdges: z.number().int().nonnegative().optional(),
    graphProjectEdges: z.number().int().nonnegative().optional(),
    graphSourceEdges: z.number().int().nonnegative().optional(),
  }),
  charts: z.object({
    knowledgeByStatusType: z.array(
      z.object({
        status: overviewKnowledgeStatusSchema,
        rule: z.number().int().nonnegative(),
        procedure: z.number().int().nonnegative(),
      }),
    ),
    dynamicScoreBuckets: z.array(
      z.object({
        bucket: overviewDynamicScoreBucketSchema,
        count: z.number().int().nonnegative(),
      }),
    ),
    compileRunsByDay: z.array(
      z.object({
        day: dayStringSchema,
        ok: z.number().int().nonnegative(),
        degraded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        avgDurationMs: z.number().nonnegative().nullable(),
      }),
    ),
    vibeRecordsByDay: z.array(
      z.object({
        day: dayStringSchema,
        records: z.number().int().nonnegative(),
      }),
    ),
    sourceCoverage: z.array(
      z.object({
        label: overviewSourceCoverageLabelSchema,
        count: z.number().int().nonnegative(),
      }),
    ),
    communitySourceCoverage: z.array(
      z.object({
        label: overviewCommunitySourceCoverageLabelSchema,
        count: z.number().int().nonnegative(),
      }),
    ),
    distillationQueue: z.array(
      z.object({
        targetKind: overviewDistillationTargetKindSchema,
        pending: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        paused: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      }),
    ),
  }),
  llmUsage: z.object({
    kpis: z.object({
      totalCalls30d: z.number().int().nonnegative(),
      measuredCalls30d: z.number().int().nonnegative(),
      estimatedCalls30d: z.number().int().nonnegative(),
      localTokensTotal30d: z.number().int().nonnegative(),
      localPromptTokens30d: z.number().int().nonnegative(),
      localCompletionTokens30d: z.number().int().nonnegative(),
      cloudTokensTotal30d: z.number().int().nonnegative(),
      cloudPromptTokens30d: z.number().int().nonnegative(),
      cloudCompletionTokens30d: z.number().int().nonnegative(),
      measuredTokensTotal30d: z.number().int().nonnegative(),
      estimatedTokensTotal30d: z.number().int().nonnegative(),
      measuredCoveragePercent30d: z.number().min(0).max(100),
      reasoningTokensTotal30d: z.number().int().nonnegative(),
      cloudCostJpyTotal30d: z.number().nonnegative(),
      cloudModel: z.string().min(1),
      cloudInputCostJpyPerMTokens: z.number().nonnegative(),
      cloudOutputCostJpyPerMTokens: z.number().nonnegative(),
    }),
    daily: z.array(
      z.object({
        day: dayStringSchema,
        localPromptTokens: z.number().int().nonnegative(),
        localCompletionTokens: z.number().int().nonnegative(),
        localReasoningTokens: z.number().int().nonnegative(),
        cloudPromptTokens: z.number().int().nonnegative(),
        cloudCompletionTokens: z.number().int().nonnegative(),
        cloudReasoningTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        measuredTokens: z.number().int().nonnegative(),
        estimatedTokens: z.number().int().nonnegative(),
        measuredCalls: z.number().int().nonnegative(),
        estimatedCalls: z.number().int().nonnegative(),
        costJpy: z.number().nonnegative(),
      }),
    ),
    bySource: z.array(
      z.object({
        source: z.string().min(1),
        calls: z.number().int().nonnegative(),
        measuredCalls: z.number().int().nonnegative(),
        estimatedCalls: z.number().int().nonnegative(),
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
      }),
    ),
  }),
  searchApiStatus: z.object({
    brave: z.object({
      status: overviewSearchApiStatusSchema,
      cooldownUntil: z.string().datetime().nullable(),
      lastError: z.string().nullable(),
    }),
    exa: z.object({
      status: overviewSearchApiStatusSchema,
      cooldownUntil: z.string().datetime().nullable(),
      lastError: z.string().nullable(),
    }),
  }),
});

export type OverviewDashboard = z.infer<typeof overviewDashboardSchema>;
