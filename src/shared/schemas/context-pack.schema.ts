import { z } from "zod";
import { retrievalModeSchema } from "./compile.schema.js";

export const contextPackStatusSchema = z.enum(["ok", "degraded", "failed"]);

export const contextPackSectionSchema = z.enum([
  "rules",
  "skills",
  "examples",
  "code_context",
  "warnings",
]);

export const contextPackItemSchema = z.object({
  id: z.string().min(1),
  itemKind: z.string().min(1),
  itemId: z.string().min(1),
  section: contextPackSectionSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  score: z.number(),
  rankingReason: z.string().min(1),
  sourceRefs: z.array(z.string()).default([]),
});

export const contextPackSchema = z.object({
  runId: z.string().uuid(),
  goal: z.string().min(1),
  intent: z.string().min(1),
  retrievalMode: retrievalModeSchema,
  status: contextPackStatusSchema,
  minimalTasks: z.array(z.string()),
  rules: z.array(contextPackItemSchema),
  skills: z.array(contextPackItemSchema),
  examples: z.array(contextPackItemSchema),
  codeContext: z.array(contextPackItemSchema),
  warnings: z.array(z.string()),
  sourceRefs: z.array(z.string()),
  diagnostics: z.object({
    degradedReasons: z.array(z.string()),
    retrievalStats: z.record(z.unknown()),
  }),
});

export type ContextPack = z.infer<typeof contextPackSchema>;
export type ContextPackItem = z.infer<typeof contextPackItemSchema>;
