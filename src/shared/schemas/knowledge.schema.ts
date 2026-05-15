import { z } from "zod";

const knowledgeTypeSchema = z.enum(["rule", "procedure"]);

const knowledgeStatusSchema = z.enum(["draft", "active", "deprecated"]);

const scopeSchema = z.enum(["repo", "global"]);
const knowledgeScoreSchema = z.number().min(0).max(100);

const knowledgeItemSchema = z.object({
  id: z.string().uuid(),
  type: knowledgeTypeSchema,
  status: knowledgeStatusSchema,
  scope: scopeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  appliesTo: z.record(z.unknown()).default({}),
  confidence: knowledgeScoreSchema,
  importance: knowledgeScoreSchema,
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
  repoPath: z.string().trim().min(1).optional(),
  files: z.array(z.string().trim().min(1)).optional(),
  changeTypes: z.array(z.string().trim().min(1)).optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  includeDraft: z.boolean().default(false),
});

export const registerKnowledgeInputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  type: knowledgeTypeSchema.default("rule"),
  status: knowledgeStatusSchema.default("draft"),
  scope: scopeSchema.default("repo"),
  confidence: knowledgeScoreSchema.optional(),
  importance: knowledgeScoreSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchInputSchema>;
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
