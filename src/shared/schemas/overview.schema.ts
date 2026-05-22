import { z } from "zod";

const dayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const overviewKnowledgeStatusSchema = z.enum(["active", "draft", "deprecated"]);
export const overviewDynamicScoreBucketSchema = z.enum(["0", "0-1", "1-5", "5-10", "10+"]);
export const overviewSourceCoverageLabelSchema = z.enum(["linked", "unlinked"]);
export const overviewDistillationTargetKindSchema = z.enum(["wiki_file", "vibe_memory"]);

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
    vibeRecords: z.number().int().nonnegative(),
    vibeSessions: z.number().int().nonnegative(),
    vibeRecordsWithDiffs: z.number().int().nonnegative(),
    agentDiffEntries: z.number().int().nonnegative(),
    compileRuns: z.number().int().nonnegative(),
    compileOkRuns: z.number().int().nonnegative(),
    compileDegradedRuns: z.number().int().nonnegative(),
    compileFailedRuns: z.number().int().nonnegative(),
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
});

export type OverviewDashboard = z.infer<typeof overviewDashboardSchema>;
