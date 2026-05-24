import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  distillationTargetStates,
  findCandidateResults,
  landscapeReviewItemCandidateLinks,
  landscapeReviewItems,
} from "../../db/schema.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../selectDistillationTarget/repository.js";
import type { LandscapeReviewCandidateDraft } from "./landscape-review-candidate.types.js";

export type LandscapeReviewItemCandidateSourceRow = typeof landscapeReviewItems.$inferSelect;
export type LandscapeReviewItemCandidateLinkRow =
  typeof landscapeReviewItemCandidateLinks.$inferSelect;

export async function listLandscapeReviewItemsForCandidateDraft(input: {
  ids?: string[];
  status: "pending" | "reviewing";
  limit: number;
}): Promise<LandscapeReviewItemCandidateSourceRow[]> {
  if (input.ids && input.ids.length > 0) {
    return db
      .select()
      .from(landscapeReviewItems)
      .where(inArray(landscapeReviewItems.id, input.ids))
      .orderBy(
        desc(landscapeReviewItems.priority),
        asc(landscapeReviewItems.createdAt),
        asc(landscapeReviewItems.id),
      );
  }

  return db
    .select()
    .from(landscapeReviewItems)
    .where(eq(landscapeReviewItems.status, input.status))
    .orderBy(
      desc(landscapeReviewItems.priority),
      asc(landscapeReviewItems.createdAt),
      asc(landscapeReviewItems.id),
    )
    .limit(input.limit);
}

export async function upsertLandscapeReviewItemCandidateDraft(params: {
  reviewItem: LandscapeReviewItemCandidateSourceRow;
  draft: LandscapeReviewCandidateDraft;
  generatedAt: string;
}): Promise<{
  targetStateId: string;
  findCandidateResultId: string;
  link: LandscapeReviewItemCandidateLinkRow;
  created: boolean;
}> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [existingLink] = await tx
      .select()
      .from(landscapeReviewItemCandidateLinks)
      .where(
        and(
          eq(landscapeReviewItemCandidateLinks.reviewItemId, params.reviewItem.id),
          eq(landscapeReviewItemCandidateLinks.candidateKey, params.draft.candidateKey),
        ),
      )
      .limit(1);

    if (existingLink) {
      return {
        targetStateId: existingLink.targetStateId,
        findCandidateResultId: existingLink.findCandidateResultId,
        link: existingLink,
        created: false,
      };
    }

    const createdAtIso =
      params.reviewItem.createdAt instanceof Date
        ? params.reviewItem.createdAt.toISOString()
        : new Date(params.reviewItem.createdAt).toISOString();
    const sortKey = `${String(100 - params.reviewItem.priority).padStart(3, "0")}:${createdAtIso}:${params.reviewItem.id}`;
    const sourceUri = `landscape://review-item/${params.reviewItem.id}/candidate/${encodeURIComponent(params.draft.targetKey)}`;
    const targetMetadata = {
      source: "landscape_review_item",
      reviewItemId: params.reviewItem.id,
      candidateKey: params.draft.candidateKey,
      reason: params.reviewItem.reason,
      proposedAction: params.reviewItem.proposedAction,
      generatedAt: params.generatedAt,
    };

    const [targetState] = await tx
      .insert(distillationTargetStates)
      .values({
        targetKind: "knowledge_candidate",
        targetKey: params.draft.targetKey,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        phase: "selected",
        priorityGroup: "knowledge_candidate",
        sortKey,
        metadata: targetMetadata,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          distillationTargetStates.targetKind,
          distillationTargetStates.targetKey,
          distillationTargetStates.distillationVersion,
        ],
        set: {
          sourceUri,
          priorityGroup: "knowledge_candidate",
          sortKey,
          metadata:
            sql`${distillationTargetStates.metadata} || ${JSON.stringify(targetMetadata)}::jsonb` as never,
          updatedAt: now,
        },
      })
      .returning();

    if (!targetState) throw new Error("failed to upsert distillation target state");

    const [existingCandidate] = await tx
      .select()
      .from(findCandidateResults)
      .where(
        and(
          eq(findCandidateResults.targetStateId, targetState.id),
          eq(findCandidateResults.candidateIndex, 0),
        ),
      )
      .orderBy(asc(findCandidateResults.createdAt), asc(findCandidateResults.id))
      .limit(1);

    const candidateRow =
      existingCandidate ??
      (
        await tx
          .insert(findCandidateResults)
          .values({
            targetStateId: targetState.id,
            candidateIndex: 0,
            title: params.draft.title,
            content: params.draft.body,
            origin: {
              source: "landscape_review_item",
              reviewItemId: params.reviewItem.id,
              candidateKey: params.draft.candidateKey,
              candidateType: params.draft.candidateType,
              reason: params.reviewItem.reason,
              proposedAction: params.reviewItem.proposedAction,
              suggestedAppliesTo: params.reviewItem.suggestedAppliesTo,
              evidence: params.reviewItem.evidence,
              generatedAt: params.generatedAt,
            },
            status: "selected",
            updatedAt: now,
          })
          .returning()
      )[0];

    if (!candidateRow) throw new Error("failed to create find candidate result");

    const [insertedLink] = await tx
      .insert(landscapeReviewItemCandidateLinks)
      .values({
        reviewItemId: params.reviewItem.id,
        targetStateId: targetState.id,
        findCandidateResultId: candidateRow.id,
        candidateKey: params.draft.candidateKey,
        status: "draft_created",
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          landscapeReviewItemCandidateLinks.reviewItemId,
          landscapeReviewItemCandidateLinks.candidateKey,
        ],
      })
      .returning();

    const link =
      insertedLink ??
      (
        await tx
          .select()
          .from(landscapeReviewItemCandidateLinks)
          .where(
            and(
              eq(landscapeReviewItemCandidateLinks.reviewItemId, params.reviewItem.id),
              eq(landscapeReviewItemCandidateLinks.candidateKey, params.draft.candidateKey),
            ),
          )
          .limit(1)
      )[0];

    if (!link) throw new Error("failed to create landscape review candidate link");

    const payloadPatch = {
      lastCandidateTargetStateId: targetState.id,
      lastCandidateResultId: candidateRow.id,
      lastCandidateCreatedAt: now.toISOString(),
    };

    await tx
      .update(landscapeReviewItems)
      .set({
        payload:
          sql`${landscapeReviewItems.payload} || ${JSON.stringify(payloadPatch)}::jsonb` as never,
        updatedAt: now,
      })
      .where(eq(landscapeReviewItems.id, params.reviewItem.id));

    return {
      targetStateId: targetState.id,
      findCandidateResultId: candidateRow.id,
      link,
      created: Boolean(insertedLink),
    };
  });
}
