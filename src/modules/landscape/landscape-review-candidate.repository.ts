import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  distillationTargetStates,
  findCandidateResults,
  landscapeReviewItemCandidateLinks,
  landscapeReviewItems,
} from "../../db/schema.js";
import { resolveKnowledgeCandidatePriorityGroup } from "../distillationTarget/priority-group.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../distillationTarget/repository.js";
import type { LandscapeReviewCandidateDraft } from "./landscape-review-candidate.types.js";

export type LandscapeReviewItemCandidateSourceRow = typeof landscapeReviewItems.$inferSelect;
export type LandscapeReviewItemCandidateLinkRow =
  typeof landscapeReviewItemCandidateLinks.$inferSelect;

type LandscapeReviewCandidateLinkStatus =
  | "draft_created"
  | "review_required"
  | "approved"
  | "rejected"
  | "finalized";

const allowedLinkTransitions: Record<
  LandscapeReviewCandidateLinkStatus,
  LandscapeReviewCandidateLinkStatus[]
> = {
  draft_created: ["review_required", "approved", "rejected"],
  review_required: ["approved", "rejected"],
  approved: ["finalized", "rejected"],
  rejected: ["approved"],
  finalized: [],
};

export class LandscapeReviewCandidateLinkError extends Error {
  readonly statusCode: 400 | 409;

  constructor(statusCode: 400 | 409, message: string) {
    super(message);
    this.name = "LandscapeReviewCandidateLinkError";
    this.statusCode = statusCode;
  }
}

export async function listLandscapeReviewItemsForCandidateDraft(input: {
  ids?: string[];
  status: "pending" | "reviewing";
  limit: number;
}): Promise<LandscapeReviewItemCandidateSourceRow[]> {
  if (input.ids && input.ids.length > 0) {
    return db
      .select()
      .from(landscapeReviewItems)
      .where(
        and(
          inArray(landscapeReviewItems.id, input.ids),
          eq(landscapeReviewItems.status, input.status),
          sql`${landscapeReviewItems.source} <> 'contradiction_detection'`,
        ),
      )
      .orderBy(
        desc(landscapeReviewItems.priority),
        asc(landscapeReviewItems.createdAt),
        asc(landscapeReviewItems.id),
      );
  }

  return db
    .select()
    .from(landscapeReviewItems)
    .where(
      and(
        eq(landscapeReviewItems.status, input.status),
        sql`${landscapeReviewItems.source} <> 'contradiction_detection'`,
      ),
    )
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
  targetStateId: string | null;
  findCandidateResultId: string | null;
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
    const priorityGroup = resolveKnowledgeCandidatePriorityGroup({
      sourceUri,
      metadata: targetMetadata,
    });

    const [targetState] = await tx
      .insert(distillationTargetStates)
      .values({
        targetKind: "knowledge_candidate",
        targetKey: params.draft.targetKey,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        phase: "selected",
        priorityGroup,
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
          priorityGroup,
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

export async function findLandscapeReviewCandidateLinkByFindCandidateResultId(
  findCandidateResultId: string,
): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const [link] = await db
    .select()
    .from(landscapeReviewItemCandidateLinks)
    .where(eq(landscapeReviewItemCandidateLinks.findCandidateResultId, findCandidateResultId))
    .limit(1);
  return link ?? null;
}

export async function findLandscapeReviewCandidateLinkByFoundCandidateId(
  foundCandidateId: string,
): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const [link] = await db
    .select()
    .from(landscapeReviewItemCandidateLinks)
    .where(eq(landscapeReviewItemCandidateLinks.foundCandidateId, foundCandidateId))
    .limit(1);
  return link ?? null;
}

export async function updateLandscapeReviewCandidateLinkStatus(params: {
  reviewItemId: string;
  linkId: string;
  status: "approved" | "rejected";
  note?: string;
  actor?: string;
}): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const [current] = await db
    .select()
    .from(landscapeReviewItemCandidateLinks)
    .where(
      and(
        eq(landscapeReviewItemCandidateLinks.id, params.linkId),
        eq(landscapeReviewItemCandidateLinks.reviewItemId, params.reviewItemId),
      ),
    )
    .limit(1);
  if (!current) return null;

  const currentStatus = current.status as LandscapeReviewCandidateLinkStatus;
  const nextStatus = params.status;
  if (
    currentStatus !== nextStatus &&
    !(allowedLinkTransitions[currentStatus] ?? []).includes(nextStatus)
  ) {
    throw new LandscapeReviewCandidateLinkError(
      409,
      `invalid link status transition: ${currentStatus} -> ${nextStatus}`,
    );
  }

  const trimmedNote = params.note?.trim();
  const trimmedActor = params.actor?.trim();
  const [updated] = await db
    .update(landscapeReviewItemCandidateLinks)
    .set({
      status: nextStatus,
      approvalNote: trimmedNote && trimmedNote.length > 0 ? trimmedNote : null,
      approvedBy: trimmedActor && trimmedActor.length > 0 ? trimmedActor : null,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(landscapeReviewItemCandidateLinks.id, params.linkId))
    .returning();

  if (!updated) {
    throw new LandscapeReviewCandidateLinkError(400, "failed to update candidate link status");
  }
  return updated;
}

export async function markLandscapeReviewCandidateLinkFinalized(
  findCandidateResultId: string,
): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const existing =
    await findLandscapeReviewCandidateLinkByFindCandidateResultId(findCandidateResultId);
  if (!existing) return null;
  if (existing.status === "finalized") return existing;
  if (existing.status !== "approved") return existing;

  const [updated] = await db
    .update(landscapeReviewItemCandidateLinks)
    .set({
      status: "finalized",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(landscapeReviewItemCandidateLinks.id, existing.id),
        eq(landscapeReviewItemCandidateLinks.status, "approved"),
      ),
    )
    .returning();

  if (updated) return updated;
  return (
    (
      await db
        .select()
        .from(landscapeReviewItemCandidateLinks)
        .where(eq(landscapeReviewItemCandidateLinks.id, existing.id))
        .limit(1)
    )[0] ?? existing
  );
}

export async function markLandscapeReviewCandidateLinkFinalizedByFoundCandidateId(
  foundCandidateId: string,
): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const existing = await findLandscapeReviewCandidateLinkByFoundCandidateId(foundCandidateId);
  if (!existing) return null;
  if (existing.status === "finalized") return existing;
  if (existing.status !== "approved") return existing;

  const [updated] = await db
    .update(landscapeReviewItemCandidateLinks)
    .set({
      status: "finalized",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(landscapeReviewItemCandidateLinks.id, existing.id),
        eq(landscapeReviewItemCandidateLinks.status, "approved"),
      ),
    )
    .returning();

  if (updated) return updated;
  return (
    (
      await db
        .select()
        .from(landscapeReviewItemCandidateLinks)
        .where(eq(landscapeReviewItemCandidateLinks.id, existing.id))
        .limit(1)
    )[0] ?? existing
  );
}

export async function markLandscapeReviewCandidateLinkReviewRequired(
  findCandidateResultId: string,
): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const existing =
    await findLandscapeReviewCandidateLinkByFindCandidateResultId(findCandidateResultId);
  if (!existing) return null;
  if (existing.status === "review_required") return existing;
  if (existing.status !== "draft_created") return existing;

  const [updated] = await db
    .update(landscapeReviewItemCandidateLinks)
    .set({
      status: "review_required",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(landscapeReviewItemCandidateLinks.id, existing.id),
        eq(landscapeReviewItemCandidateLinks.status, "draft_created"),
      ),
    )
    .returning();

  if (updated) return updated;
  return (
    (
      await db
        .select()
        .from(landscapeReviewItemCandidateLinks)
        .where(eq(landscapeReviewItemCandidateLinks.id, existing.id))
        .limit(1)
    )[0] ?? existing
  );
}

export async function markLandscapeReviewCandidateLinkReviewRequiredByFoundCandidateId(
  foundCandidateId: string,
): Promise<LandscapeReviewItemCandidateLinkRow | null> {
  const existing = await findLandscapeReviewCandidateLinkByFoundCandidateId(foundCandidateId);
  if (!existing) return null;
  if (existing.status === "review_required") return existing;
  if (existing.status !== "draft_created") return existing;

  const [updated] = await db
    .update(landscapeReviewItemCandidateLinks)
    .set({
      status: "review_required",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(landscapeReviewItemCandidateLinks.id, existing.id),
        eq(landscapeReviewItemCandidateLinks.status, "draft_created"),
      ),
    )
    .returning();

  if (updated) return updated;
  return (
    (
      await db
        .select()
        .from(landscapeReviewItemCandidateLinks)
        .where(eq(landscapeReviewItemCandidateLinks.id, existing.id))
        .limit(1)
    )[0] ?? existing
  );
}
