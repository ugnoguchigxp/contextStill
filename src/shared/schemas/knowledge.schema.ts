import { z } from "zod";

const knowledgeTypeSchema = z.enum(["rule", "procedure"]);

const knowledgeStatusSchema = z.enum(["draft", "active", "deprecated"]);

const scopeSchema = z.enum(["repo", "global"]);
const knowledgeScoreSchema = z.number().min(0).max(100);

const optionalKnowledgeScoreSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}, knowledgeScoreSchema.optional());

const optionalApplicabilityBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}, z.boolean().optional());

const optionalApplicabilityStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().optional());

const optionalApplicabilityArraySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return undefined;
}, z.array(z.string().trim().min(1)).optional());

const knowledgeApplicabilitySchema = z.object({
  general: optionalApplicabilityBooleanSchema,
  technologies: optionalApplicabilityArraySchema,
  changeTypes: optionalApplicabilityArraySchema,
  domains: optionalApplicabilityArraySchema,
  repoPath: optionalApplicabilityStringSchema,
  repoKey: optionalApplicabilityStringSchema,
});

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
  changeTypes: z.array(z.string().trim().min(1)).optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  domains: z.array(z.string().trim().min(1)).optional(),
  includeGeneral: z.boolean().default(true),
  includeDraft: z.boolean().default(false),
});

export const registerKnowledgeInputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  type: knowledgeTypeSchema.default("rule"),
  status: knowledgeStatusSchema.default("draft"),
  scope: scopeSchema.default("repo"),
  confidence: optionalKnowledgeScoreSchema,
  importance: optionalKnowledgeScoreSchema,
  appliesTo: knowledgeApplicabilitySchema.optional(),
  general: optionalApplicabilityBooleanSchema,
  technologies: optionalApplicabilityArraySchema,
  changeTypes: optionalApplicabilityArraySchema,
  domains: optionalApplicabilityArraySchema,
  repoPath: optionalApplicabilityStringSchema,
  repoKey: optionalApplicabilityStringSchema,
  metadata: z.record(z.unknown()).default({}),
});

export const registerCandidateInputSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    type: knowledgeTypeSchema.optional(),
    confidence: optionalKnowledgeScoreSchema,
    importance: optionalKnowledgeScoreSchema,
    appliesTo: knowledgeApplicabilitySchema.optional(),
    general: optionalApplicabilityBooleanSchema,
    technologies: optionalApplicabilityArraySchema,
    changeTypes: optionalApplicabilityArraySchema,
    domains: optionalApplicabilityArraySchema,
    repoPath: optionalApplicabilityStringSchema,
    repoKey: optionalApplicabilityStringSchema,
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((value, context) => {
    if (value.body || value.text) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: "body or text is required",
    });
  });

export const listKnowledgeInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  status: knowledgeStatusSchema.optional(),
  type: knowledgeTypeSchema.optional(),
  query: z.string().trim().optional(),
});

const knowledgeUpdatePatchSchema = z.object({
  type: knowledgeTypeSchema.optional(),
  status: knowledgeStatusSchema.optional(),
  scope: scopeSchema.optional(),
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  confidence: optionalKnowledgeScoreSchema,
  importance: optionalKnowledgeScoreSchema,
  appliesTo: knowledgeApplicabilitySchema.optional(),
  general: optionalApplicabilityBooleanSchema,
  technologies: optionalApplicabilityArraySchema,
  changeTypes: optionalApplicabilityArraySchema,
  domains: optionalApplicabilityArraySchema,
  repoPath: optionalApplicabilityStringSchema,
  repoKey: optionalApplicabilityStringSchema,
  metadata: z.record(z.unknown()).optional(),
});

export const updateKnowledgeInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .merge(knowledgeUpdatePatchSchema)
  .refine(
    (value) =>
      value.type !== undefined ||
      value.status !== undefined ||
      value.scope !== undefined ||
      value.title !== undefined ||
      value.body !== undefined ||
      value.confidence !== undefined ||
      value.importance !== undefined ||
      value.appliesTo !== undefined ||
      value.general !== undefined ||
      value.technologies !== undefined ||
      value.changeTypes !== undefined ||
      value.domains !== undefined ||
      value.repoPath !== undefined ||
      value.repoKey !== undefined ||
      value.metadata !== undefined,
    { message: "at least one update field is required" },
  );

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;
export type KnowledgeApplicabilityInput = z.infer<typeof knowledgeApplicabilitySchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchInputSchema>;
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
