import { z } from "zod";

export const contextEvalCaseSchema = z
  .object({
    id: z.string().optional(),
    goal: z.string().trim().min(1),
    changeTypes: z.array(z.string().trim().min(1)).optional(),
    technologies: z.array(z.string().trim().min(1)).optional(),
    domains: z.array(z.string().trim().min(1)).optional(),
    expectedKnowledgeIds: z.array(z.string().trim().min(1)).optional(),
    forbiddenKnowledgeIds: z.array(z.string().trim().min(1)).optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      const expected = new Set(data.expectedKnowledgeIds || []);
      const forbidden = data.forbiddenKnowledgeIds || [];
      return !forbidden.some((id) => expected.has(id));
    },
    {
      message: "expectedKnowledgeIds and forbiddenKnowledgeIds must not overlap",
      path: ["forbiddenKnowledgeIds"],
    },
  );

export type ContextEvalCase = z.infer<typeof contextEvalCaseSchema>;

export const contextEvalCaseResultSchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.enum(["passed", "failed"]),
  retrievedKnowledgeIds: z.array(z.string()),
  expectedKnowledgeIds: z.array(z.string()),
  expectedHitIds: z.array(z.string()),
  missingExpectedIds: z.array(z.string()),
  forbiddenKnowledgeIds: z.array(z.string()),
  forbiddenHitIds: z.array(z.string()),
  degradedReasons: z.array(z.string()),
});

export type ContextEvalCaseResult = z.infer<typeof contextEvalCaseResultSchema>;

export const contextEvalCaseReportSchema = z.object({
  generatedAt: z.string(),
  source: z.object({
    mode: z.literal("cases"),
    path: z.string(),
    currentLimit: z.number(),
    readOnly: z.literal(true),
  }),
  summary: z.object({
    status: z.enum(["passed", "failed", "no_data"]),
    caseCount: z.number(),
    passedCount: z.number(),
    failedCount: z.number(),
    passRate: z.number(),
    reason: z.string(),
  }),
  metrics: z.object({
    expectedTotalCount: z.number(),
    expectedHitCount: z.number(),
    missingExpectedCount: z.number(),
    forbiddenTotalCount: z.number(),
    forbiddenHitCount: z.number(),
    retrievedTotalCount: z.number(),
    expectedRecall: z.number().nullable(),
    strictPrecision: z.number().nullable(),
    strictF1: z.number().nullable(),
    noContentCaseCount: z.number(),
    degradedCaseCount: z.number(),
  }),
  cases: z.array(contextEvalCaseResultSchema),
});

export type ContextEvalCaseReport = z.infer<typeof contextEvalCaseReportSchema>;
