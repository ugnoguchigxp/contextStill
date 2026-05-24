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
  limit: z.coerce.number().int().min(1).max(200).default(20),
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

export type LandscapeReviewCandidateCreateInput = z.infer<
  typeof landscapeReviewCandidateCreateInputSchema
>;
export type LandscapeReviewCandidateCreateResult = z.infer<
  typeof landscapeReviewCandidateCreateResultSchema
>;
