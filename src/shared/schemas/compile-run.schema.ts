import { z } from "zod";
import { retrievalModeSchema } from "./compile.schema.js";
import { contextPackSchema } from "./context-pack.schema.js";

export const compileRunSourceSchema = z.enum(["ui", "mcp", "cli", "unknown"]);

export const compileRunStatusSchema = z.enum(["ok", "degraded", "failed"]);

export const compileRunSummarySchema = z.object({
  id: z.string().uuid(),
  goal: z.string(),
  retrievalMode: retrievalModeSchema,
  status: compileRunStatusSchema,
  degradedReasons: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  source: compileRunSourceSchema,
  evalSummary: z
    .object({
      count: z.number().int().nonnegative(),
      latestAvg: z.number().int().min(0).max(100).nullable(),
      averageAvg: z.number().nullable(),
      latestOutcome: z.enum(["useful", "partial", "misleading", "unused"]).nullable(),
      latestEvaluatedAt: z.string().datetime().nullable(),
    })
    .optional()
    .default({
      count: 0,
      latestAvg: null,
      averageAvg: null,
      latestOutcome: null,
      latestEvaluatedAt: null,
    }),
  createdAt: z.string().datetime(),
});

export const compileRunSelectedItemSchema = z.object({
  itemKind: z.string(),
  itemId: z.string(),
  section: z.string(),
  score: z.number(),
  rankingReason: z.string(),
  sourceRefs: z.array(z.string()),
});

export const knowledgeUsageVerdictSchema = z.enum(["used", "not_used", "off_topic", "wrong"]);
export const episodeUsageVerdictSchema = z.enum(["used", "not_used", "wrong"]);

export const compileRunKnowledgeFeedbackSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  knowledgeId: z.string().uuid(),
  verdict: knowledgeUsageVerdictSchema,
  actor: z.enum(["agent", "user", "system"]),
  reason: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const compileRunKnowledgeFeedbackWriteSchema = z.object({
  items: z
    .array(
      z.object({
        knowledgeId: z.string().uuid(),
        verdict: knowledgeUsageVerdictSchema,
        reason: z.string().trim().max(160).optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const compileRunKnowledgeFeedbackResultSchema = z.object({
  savedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  queueCreatedCount: z.number().int().nonnegative(),
  queueDismissedCount: z.number().int().nonnegative(),
  affectedKnowledgeIds: z.array(z.string().uuid()),
});

export const compileRunEpisodeFeedbackWriteSchema = z.object({
  items: z
    .array(
      z.object({
        episodeId: z.string().trim().min(1),
        verdict: episodeUsageVerdictSchema,
        reason: z.string().trim().max(160).optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const compileRunEpisodeFeedbackResultSchema = z.object({
  savedCount: z.number().int().nonnegative(),
  affectedEpisodeIds: z.array(z.string()),
});

export const compileRunKnowledgeSignalSchema = z.object({
  knowledgeId: z.string(),
  rawId: z.string(),
  itemKind: z.enum(["rule", "procedure"]),
  section: z.enum(["rules", "procedures", "guardrails"]),
  title: z.string(),
  score: z.number(),
  rankingReason: z.string(),
  autoVerdict: knowledgeUsageVerdictSchema.nullable(),
  autoActor: z.enum(["agent", "user", "system"]).nullable(),
  autoReason: z.string().nullable(),
  effectiveVerdict: knowledgeUsageVerdictSchema.nullable(),
  effectiveActor: z.enum(["agent", "user", "system"]).nullable(),
  effectiveReason: z.string().nullable(),
  hasUserOverride: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
});

export const compileRunEpisodeSignalSchema = z.object({
  episodeId: z.string(),
  title: z.string(),
  section: z.literal("procedures"),
  sourceRefs: z.array(z.string()),
  effectiveVerdict: episodeUsageVerdictSchema.nullable().default(null),
  effectiveActor: z.enum(["agent", "user", "system"]).nullable().default(null),
  effectiveReason: z.string().nullable().default(null),
  updatedAt: z.string().datetime().nullable().default(null),
});

export const compileRunInputSnapshotSchema = z.record(z.string(), z.unknown());

export const compileRunDetailSchema = z.object({
  run: compileRunSummarySchema.extend({
    tokenBudget: z.number().int().nonnegative(),
    input: compileRunInputSnapshotSchema,
  }),
  pack: contextPackSchema.nullable(),
  outputMarkdown: z.string().nullable().optional(),
  selectedItems: z.array(compileRunSelectedItemSchema),
  episodeSignals: z.array(compileRunEpisodeSignalSchema).default([]),
  knowledgeFeedback: z.array(compileRunKnowledgeFeedbackSchema).default([]),
  knowledgeSignals: z.array(compileRunKnowledgeSignalSchema).default([]),
  evaluations: z
    .array(
      z.object({
        id: z.string().uuid(),
        runId: z.string().uuid(),
        sessionId: z.string().nullable(),
        avg: z.number().int().min(0).max(100),
        outcome: z.enum(["useful", "partial", "misleading", "unused"]),
        title: z.string().nullable(),
        body: z.string(),
        source: z.enum(["mcp", "ui", "system", "import"]),
        relevance: z.number().int().min(0).max(100).nullable(),
        actionability: z.number().int().min(0).max(100).nullable(),
        coverage: z.number().int().min(0).max(100).nullable(),
        clarity: z.number().int().min(0).max(100).nullable(),
        specificity: z.number().int().min(0).max(100).nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      }),
    )
    .default([]),
  snapshotAvailable: z.boolean(),
});

export const compileRunRankingTraceItemSchema = z.object({
  itemKind: z.enum(["rule", "procedure"]),
  itemId: z.string().uuid(),
  title: z.string(),
  status: z.enum(["active", "draft", "deprecated"]),
  textRank: z.number().int().nullable(),
  textScore: z.number().nullable(),
  vectorRank: z.number().int().nullable(),
  vectorScore: z.number().nullable(),
  mergedRank: z.number().int().nullable(),
  mergedScore: z.number().nullable(),
  finalRank: z.number().int().nullable(),
  finalScore: z.number().nullable(),
  selected: z.boolean(),
  packed: z.boolean(),
  packPosition: z.number().int().nullable(),
  suppressed: z.boolean(),
  suppressionReason: z.string().nullable(),
  agenticDecision: z.enum(["not_evaluated", "accepted", "rejected", "skipped"]),
  rankingReason: z.string().nullable(),
  communityKey: z.string().nullable(),
  feedback: z.object({
    verdict: knowledgeUsageVerdictSchema.nullable(),
    actor: z.enum(["agent", "user", "system"]).nullable(),
    reason: z.string().nullable(),
    updatedAt: z.string().datetime().nullable(),
  }),
  sourceRefs: z.array(z.string()),
});

export const compileRunRankingTraceSchema = z.object({
  run: z.object({
    id: z.string().uuid(),
    goal: z.string(),
    repoPath: z.string().nullable(),
    retrievalMode: retrievalModeSchema,
    status: compileRunStatusSchema,
    input: compileRunInputSnapshotSchema,
    createdAt: z.string().datetime(),
  }),
  evalSummary: z.object({
    count: z.number().int().nonnegative(),
    latestAvg: z.number().int().min(0).max(100).nullable(),
    latestOutcome: z.enum(["useful", "partial", "misleading", "unused"]).nullable(),
  }),
  feedbackSummary: z.object({
    used: z.number().int().nonnegative(),
    notUsed: z.number().int().nonnegative(),
    offTopic: z.number().int().nonnegative(),
    wrong: z.number().int().nonnegative(),
    noSignal: z.number().int().nonnegative(),
  }),
  funnel: z.object({
    textHitCount: z.number().int().nonnegative(),
    vectorHitCount: z.number().int().nonnegative(),
    mergedCount: z.number().int().nonnegative(),
    finalCount: z.number().int().nonnegative(),
    packedCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    suppressedCount: z.number().int().nonnegative(),
  }),
  items: z.array(compileRunRankingTraceItemSchema),
});

export type CompileRunSource = z.infer<typeof compileRunSourceSchema>;
export type CompileRunSelectedItem = z.infer<typeof compileRunSelectedItemSchema>;
export type CompileRunEpisodeFeedbackResult = z.infer<typeof compileRunEpisodeFeedbackResultSchema>;
export type CompileRunKnowledgeFeedbackResult = z.infer<
  typeof compileRunKnowledgeFeedbackResultSchema
>;
export type CompileRunDetail = z.infer<typeof compileRunDetailSchema>;
export type CompileRunRankingTrace = z.infer<typeof compileRunRankingTraceSchema>;
