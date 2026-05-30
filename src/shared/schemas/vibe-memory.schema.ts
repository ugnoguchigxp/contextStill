import { z } from "zod";

const vibeMemoryTypeSchema = z.enum(["chat", "action", "observation", "system"]);

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const agentDiffEntryInputSchema = z
  .object({
    filePath: z.string().trim().min(1),
    diffHunk: z.string().optional(),
    diff: z.string().optional(),
    changeType: z.string().trim().min(1).nullable().optional(),
    language: z.string().trim().min(1).nullable().optional(),
    symbolName: z.string().trim().min(1).nullable().optional(),
    symbolKind: z.string().trim().min(1).nullable().optional(),
    signature: z.string().nullable().optional(),
    startLine: z.number().int().positive().nullable().optional(),
    endLine: z.number().int().positive().nullable().optional(),
    metadata: metadataSchema,
  })
  .transform((value) => ({
    ...value,
    diffHunk: value.diffHunk ?? value.diff,
  }))
  .refine((value) => Boolean(value.diffHunk?.trim()), {
    message: "Agent diff entry requires diffHunk or diff",
  });

const agentDiffSymbolInputSchema = z.object({
  symbolName: z.string().trim().min(1),
  symbolKind: z.string().trim().min(1),
  signature: z.string().nullable().optional(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  metadata: metadataSchema,
});

export const recordVibeMemoryInputSchema = z.object({
  sessionId: z.string().trim().min(1),
  content: z.string().min(1),
  memoryType: vibeMemoryTypeSchema.default("chat"),
  metadata: metadataSchema,
  diff: z.string().optional(),
  agentDiffs: z.array(agentDiffEntryInputSchema).default([]),
});

export const recordVibeMemoryCapsuleInputSchema = z.object({
  goalId: z.string().trim().min(1),
  goalUri: z.string().trim().min(1).optional(),
  goalAnchorRef: z.string().trim().min(1).optional(),
  parentId: z.string().uuid().nullable().optional(),
  subject: z.string().trim().optional(),
  intent: z.enum([
    "ask",
    "note",
    "finding",
    "review",
    "question",
    "answer",
    "decision",
    "risk",
    "warning",
    "patch",
    "result",
    "verify",
    "checkpoint",
  ]),
  wants: z.array(z.string()).default([]),
  text: z.string().min(1),
  refs: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"]).nullable().optional(),
  metadata: metadataSchema,
  actorId: z.string().trim().min(1),
  ttlHours: z.number().int().positive().nullable().optional(),
});

export const markVibeMemoryInputSchema = z.object({
  goalId: z.string().trim().min(1),
  targetMemoryId: z.string().uuid(),
  mark: z.enum([
    "resolved",
    "verified",
    "needs_fix",
    "needs_verify",
    "stale",
    "superseded",
    "wrong",
    "accepted_risk",
    "pinned",
  ]),
  note: z.string().trim().optional(),
  actorId: z.string().trim().min(1),
});

export type AgentDiffEntryInput = z.output<typeof agentDiffEntryInputSchema>;
export type AgentDiffSymbolInput = z.input<typeof agentDiffSymbolInputSchema>;
export type RecordVibeMemoryInput = z.input<typeof recordVibeMemoryInputSchema>;
export type RecordVibeMemoryCapsuleInput = z.input<typeof recordVibeMemoryCapsuleInputSchema>;
export type MarkVibeMemoryInput = z.input<typeof markVibeMemoryInputSchema>;
