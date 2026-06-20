import { z } from "zod";
import {
  landscapeReviewItemProposedActionSchema,
  landscapeReviewItemReasonSchema,
} from "./landscape-review.schema.js";

export const landscapeReviewCandidateSelectionStatusSchema = z.enum(["pending", "reviewing"]);

export const landscapeReviewCandidateLinkStatusSchema = z.enum([
  "draft_created",
  "review_required",
  "approved",
  "rejected",
  "finalized",
]);

export const landscapeReviewCandidateCreateInputSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).optional(),
  status: landscapeReviewCandidateSelectionStatusSchema.default("pending"),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  dryRun: z.boolean().default(false),
});

export const landscapeReviewCandidateCreateItemSchema = z.object({
  reviewItemId: z.string(),
  reason: landscapeReviewItemReasonSchema,
  proposedAction: landscapeReviewItemProposedActionSchema,
  candidateType: z.enum(["rule", "procedure"]),
  candidateKey: z.string().min(1),
  targetKey: z.string().min(1),
  targetStateId: z.string().nullable(),
  findCandidateResultId: z.string().nullable(),
  linkId: z.string().nullable(),
  linkStatus: landscapeReviewCandidateLinkStatusSchema.nullable(),
  draftLinked: z.boolean(),
});

export const landscapeReviewCandidateCreateResultSchema = z.object({
  dryRun: z.boolean(),
  processedCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  existingCount: z.number().int().nonnegative(),
  missingIds: z.array(z.string()),
  items: z.array(landscapeReviewCandidateCreateItemSchema),
});

export const landscapeReviewCandidateLinkSchema = z.object({
  id: z.string(),
  reviewItemId: z.string(),
  targetStateId: z.string().nullable(),
  findCandidateResultId: z.string().nullable(),
  candidateKey: z.string().min(1),
  status: landscapeReviewCandidateLinkStatusSchema,
  approvalNote: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const landscapeReviewCandidateLinkUpdateInputSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
  actor: z.string().trim().min(1).max(120).optional(),
});

export const landscapeReviewCandidateLinkUpdateResultSchema = z.object({
  link: landscapeReviewCandidateLinkSchema,
});

export type LandscapeReviewCandidateCreateInput = z.infer<
  typeof landscapeReviewCandidateCreateInputSchema
>;
export type LandscapeReviewCandidateCreateResult = z.infer<
  typeof landscapeReviewCandidateCreateResultSchema
>;
export type LandscapeReviewCandidateLink = z.infer<typeof landscapeReviewCandidateLinkSchema>;
export type LandscapeReviewCandidateLinkUpdateInput = z.infer<
  typeof landscapeReviewCandidateLinkUpdateInputSchema
>;
export type LandscapeReviewCandidateLinkUpdateResult = z.infer<
  typeof landscapeReviewCandidateLinkUpdateResultSchema
>;
