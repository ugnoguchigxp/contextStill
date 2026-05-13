import { z } from "zod";

export const knowledgeTypeSchema = z.enum([
  "fact",
  "decision",
  "rule",
  "procedure",
  "skill",
  "risk",
  "lesson",
  "example",
]);

export const knowledgeStatusSchema = z.enum([
  "candidate",
  "draft",
  "trial",
  "active",
  "deprecated",
  "rejected",
]);

export const scopeSchema = z.enum(["user", "repo", "workspace", "org", "global"]);

export const knowledgeItemSchema = z.object({
  id: z.string().uuid(),
  type: knowledgeTypeSchema,
  status: knowledgeStatusSchema,
  scope: scopeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  appliesTo: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastVerifiedAt: z.coerce.date().nullable().optional(),
});

export const knowledgeSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  types: z.array(knowledgeTypeSchema).optional(),
  statuses: z.array(knowledgeStatusSchema).min(1).optional(),
  status: knowledgeStatusSchema.default("active"),
});

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchInputSchema>;
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
