import { z } from "zod";
import { landscapeReviewItemStatusSchema } from "./landscape-review.schema.js";

export const landscapeContradictionOverlayItemSchema = z.object({
  reviewItemId: z.string().min(1),
  leftKnowledgeId: z.string().min(1),
  rightKnowledgeId: z.string().min(1),
  pairKey: z.string().min(1),
  confidence: z.number().min(0).max(1),
  confidenceLabel: z.enum(["low", "medium", "high"]),
  status: landscapeReviewItemStatusSchema,
  evidence: z.array(z.string()),
  communityKey: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const landscapeContradictionOverlayListSchema = z.object({
  items: z.array(landscapeContradictionOverlayItemSchema),
  count: z.number().int().nonnegative(),
});

export const landscapeContradictionOverlayQuerySchema = z.object({
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.union([landscapeReviewItemStatusSchema, z.literal("all")]).default("pending"),
  ),
  confidenceMin: z.coerce.number().min(0).max(1).default(0.62),
  limit: z.coerce.number().int().min(1).max(200).default(80),
});

export type LandscapeContradictionOverlayItem = z.infer<
  typeof landscapeContradictionOverlayItemSchema
>;
export type LandscapeContradictionOverlayList = z.infer<
  typeof landscapeContradictionOverlayListSchema
>;
export type LandscapeContradictionOverlayQuery = z.infer<
  typeof landscapeContradictionOverlayQuerySchema
>;
