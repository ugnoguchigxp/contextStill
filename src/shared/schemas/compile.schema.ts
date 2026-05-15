import { z } from "zod";

const intentSchema = z.enum(["plan", "edit", "debug", "review", "finish"]);
const errorKindSchema = z.enum(["typecheck", "lint", "test", "runtime", "build", "unknown"]);
const errorContextSchema = z
  .object({
    command: z.string().trim().min(1).max(240).optional(),
    output: z.string().trim().min(1).max(4000).optional(),
    stack: z.string().trim().min(1).max(4000).optional(),
    files: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.command ||
          value.output ||
          value.stack ||
          (Array.isArray(value.files) && value.files.length > 0),
      ),
    {
      message: "lastErrorContext must include at least one of command/output/stack/files",
    },
  );
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
  errorKind: errorKindSchema.optional(),
  lastErrorContext: errorContextSchema.optional(),
  queryEmbedding: z.array(z.number()).optional(),
});

export type CompileInput = z.infer<typeof compileInputSchema>;
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;
export type CompileErrorKind = z.infer<typeof errorKindSchema>;
