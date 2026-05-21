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

export const compileRunInputSnapshotSchema = z.record(z.string(), z.unknown());

export const compileRunDetailSchema = z.object({
  run: compileRunSummarySchema.extend({
    tokenBudget: z.number().int().nonnegative(),
    input: compileRunInputSnapshotSchema,
  }),
  pack: contextPackSchema.nullable(),
  selectedItems: z.array(compileRunSelectedItemSchema),
  snapshotAvailable: z.boolean(),
});

export type CompileRunSource = z.infer<typeof compileRunSourceSchema>;
export type CompileRunSummaryPayload = z.infer<typeof compileRunSummarySchema>;
export type CompileRunSelectedItem = z.infer<typeof compileRunSelectedItemSchema>;
export type CompileRunDetail = z.infer<typeof compileRunDetailSchema>;
