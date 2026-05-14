import { z } from "zod";

export const vibeMemoryTypeSchema = z.enum(["chat", "action", "observation", "system"]);

const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const artifactSymbolInputSchema = z.object({
  symbolName: z.string().trim().min(1),
  symbolKind: z.string().trim().min(1),
  content: z.string().optional(),
  signature: z.string().nullable().optional(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  metadata: metadataSchema,
});

export const aiArtifactInputSchema = z
  .object({
    filePath: z.string().trim().min(1),
    content: z.string().optional(),
    diff: z.string().optional(),
    language: z.string().trim().min(1).optional(),
    metadata: metadataSchema,
    symbols: z.array(artifactSymbolInputSchema).default([]),
  })
  .refine((value) => Boolean(value.content?.trim() || value.diff?.trim()), {
    message: "Artifact requires content or diff",
  });

export const recordActivityInputSchema = z.object({
  sessionId: z.string().trim().min(1),
  content: z.string().min(1),
  memoryType: vibeMemoryTypeSchema.default("chat"),
  metadata: metadataSchema,
  diff: z.string().optional(),
  artifacts: z.array(aiArtifactInputSchema).default([]),
});

export type ArtifactSymbolInput = z.input<typeof artifactSymbolInputSchema>;
export type AiArtifactInput = z.input<typeof aiArtifactInputSchema>;
export type RecordActivityInput = z.input<typeof recordActivityInputSchema>;
