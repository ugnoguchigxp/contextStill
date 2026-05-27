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
      latestScore: z.number().int().min(0).max(100).nullable(),
      averageScore: z.number().nullable(),
      latestOutcome: z.enum(["useful", "partial", "misleading", "unused"]).nullable(),
      latestEvaluatedAt: z.string().datetime().nullable(),
    })
    .optional()
    .default({
      count: 0,
      latestScore: null,
      averageScore: null,
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

export const compileRunKnowledgeSignalSchema = z.object({
  knowledgeId: z.string(),
  rawId: z.string(),
  itemKind: z.enum(["rule", "procedure"]),
  section: z.enum(["rules", "procedures"]),
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

export const compileRunInputSnapshotSchema = z.record(z.string(), z.unknown());

export const compileRunDetailSchema = z.object({
  run: compileRunSummarySchema.extend({
    tokenBudget: z.number().int().nonnegative(),
    input: compileRunInputSnapshotSchema,
  }),
  pack: contextPackSchema.nullable(),
  outputMarkdown: z.string().nullable().optional(),
  selectedItems: z.array(compileRunSelectedItemSchema),
  knowledgeFeedback: z.array(compileRunKnowledgeFeedbackSchema).default([]),
  knowledgeSignals: z.array(compileRunKnowledgeSignalSchema).default([]),
  evaluations: z
    .array(
      z.object({
        id: z.string().uuid(),
        runId: z.string().uuid(),
        sessionId: z.string().nullable(),
        score: z.number().int().min(0).max(100),
        outcome: z.enum(["useful", "partial", "misleading", "unused"]),
        title: z.string().nullable(),
        body: z.string(),
        source: z.enum(["mcp", "ui", "system", "import"]),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      }),
    )
    .default([]),
  snapshotAvailable: z.boolean(),
});

export type CompileRunSource = z.infer<typeof compileRunSourceSchema>;
export type CompileRunSelectedItem = z.infer<typeof compileRunSelectedItemSchema>;
export type CompileRunKnowledgeFeedbackResult = z.infer<
  typeof compileRunKnowledgeFeedbackResultSchema
>;
export type CompileRunDetail = z.infer<typeof compileRunDetailSchema>;
