import { z } from "zod";

export const intentSchema = z.enum(["plan", "edit", "debug", "review", "finish"]);
export const retrievalModeSchema = z.enum([
  "task_context",
  "review_context",
  "debug_context",
  "architecture_context",
  "procedure_context",
  "learning_context",
]);

export const compileInputSchema = z.object({
  goal: z.string().trim().min(1),
  intent: intentSchema.default("edit"),
  retrievalMode: retrievalModeSchema.optional(),
  repoPath: z.string().trim().min(1).optional(),
  files: z.array(z.string().trim().min(1)).optional(),
  changeTypes: z.array(z.string().trim().min(1)).optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  tokenBudget: z.number().int().min(256).max(20000).optional(),
  includeDraft: z.boolean().default(false),
  queryEmbedding: z.array(z.number()).optional(),
});

export type CompileInput = z.infer<typeof compileInputSchema>;
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;
