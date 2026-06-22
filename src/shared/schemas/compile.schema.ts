import { z } from "zod";

export const retrievalModeSchema = z.enum([
  "task_context",
  "review_context",
  "debug_context",
  "architecture_context",
  "procedure_context",
  "learning_context",
  "sqlite_text",
]);

export const compileInputSchema = z.object({
  goal: z.string().trim().min(1),
  intent: z.string().trim().min(1).optional(),
  retrievalMode: retrievalModeSchema.optional(),
  changeTypes: z.array(z.string().trim().min(1)).optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  domains: z.array(z.string().trim().min(1)).optional(),
  files: z.array(z.string().trim().min(1)).optional(),
  repoPath: z.string().trim().min(1).optional(),
  repoKey: z.string().trim().min(1).optional(),
  includeDraft: z.boolean().optional(),
  tokenBudget: z.number().int().positive().optional(),
  queryEmbedding: z.array(z.number()).optional(),
});

export type CompileInput = z.infer<typeof compileInputSchema>;
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;

function hasChangeType(values: string[] | undefined, candidate: string): boolean {
  if (!values || values.length === 0) return false;
  const normalized = candidate.trim().toLowerCase();
  return values.some((value) => value.trim().toLowerCase() === normalized);
}

export function deriveRetrievalModeFromChangeTypes(
  changeTypes: string[] | undefined,
): RetrievalMode {
  if (hasChangeType(changeTypes, "debug")) return "debug_context";
  if (hasChangeType(changeTypes, "review")) return "review_context";
  if (hasChangeType(changeTypes, "plan") || hasChangeType(changeTypes, "docs")) {
    return "architecture_context";
  }
  if (hasChangeType(changeTypes, "procedure")) return "procedure_context";
  if (hasChangeType(changeTypes, "learning")) return "learning_context";
  return "task_context";
}
