import { z } from "zod";

export const compileEvalOutcomeSchema = z.enum(["useful", "partial", "misleading", "unused"]);

export const compileEvalInputSchema = z.object({
  runId: z.string().uuid().optional(),
  outcome: compileEvalOutcomeSchema,
  title: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(10000),
  relevance: z.number().int().min(0).max(100),
  actionability: z.number().int().min(0).max(100),
  coverage: z.number().int().min(0).max(100),
  clarity: z.number().int().min(0).max(100),
  specificity: z.number().int().min(0).max(100),
});

export const compileEvalRecordSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  sessionId: z.string().nullable(),
  avg: z.number().int().min(0).max(100),
  outcome: compileEvalOutcomeSchema,
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
});

export const compileEvalSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  latestAvg: z.number().int().min(0).max(100).nullable(),
  averageAvg: z.number().nullable(),
  latestOutcome: compileEvalOutcomeSchema.nullable(),
  latestEvaluatedAt: z.string().datetime().nullable(),
});

export const compileEvalToolResultSchema = z.object({
  evaluation: compileEvalRecordSchema,
  resolvedFrom: z.enum(["explicit_run_id", "latest_session_run"]),
});

export type CompileEvalInput = z.infer<typeof compileEvalInputSchema>;
