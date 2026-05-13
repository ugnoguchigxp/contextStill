import { z } from "zod";

export const sourceKindSchema = z.enum([
  "markdown",
  "session",
  "tool_output",
  "git",
  "web",
  "manual",
]);

export const evidenceSourceSchema = z.object({
  id: z.string().uuid(),
  sourceKind: sourceKindSchema,
  uri: z.string().min(1),
  title: z.string().nullable().optional(),
  contentHash: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const evidenceFragmentSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  locator: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
});

export const evidenceSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  sourceKinds: z.array(sourceKindSchema).optional(),
});

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceFragment = z.infer<typeof evidenceFragmentSchema>;
export type EvidenceSearchInput = z.infer<typeof evidenceSearchInputSchema>;
