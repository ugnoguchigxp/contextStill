import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
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

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

function nullableDate(value: unknown): Date | null {
  if (!value) return null;
  const date = toDate(value);
  return date.getTime() === 0 ? null : date;
}

function mapSqliteReviewItemCandidateSourceRow(
  row: Record<string, unknown>,
): LandscapeReviewItemCandidateSourceRow {
  return {
    id: String(row.id),
    source: String(row.source),
    reason: String(row.reason),
    status: String(row.status),
    proposedAction: String(row.proposed_action),
    priority: Number(row.priority ?? 0),
    confidence: String(row.confidence),
    idempotencyKey: String(row.idempotency_key),
    knowledgeId: row.knowledge_id ? String(row.knowledge_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    triggerEventId: row.trigger_event_id ? String(row.trigger_event_id) : null,
    communityKey: row.community_key ? String(row.community_key) : null,
    communityLabel: row.community_label ? String(row.community_label) : null,
    suggestedAppliesTo: parseJsonValue(row.suggested_applies_to, {}),
    evidence: parseJsonValue(row.evidence, []),
    payload: parseJsonValue(row.payload, {}),
    note: row.note ? String(row.note) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    resolvedAt: nullableDate(row.resolved_at),
  } as LandscapeReviewItemCandidateSourceRow;
}

function mapSqliteCandidateLinkRow(row: Record<string, unknown>): LandscapeReviewItemCandidateLinkRow {
  return {
    id: String(row.id),
    reviewItemId: String(row.review_item_id),
    targetStateId: row.target_state_id ? String(row.target_state_id) : null,
    findCandidateResultId: row.find_candidate_result_id
      ? String(row.find_candidate_result_id)
      : null,
    findingJobId: row.finding_job_id ? String(row.finding_job_id) : null,
    foundCandidateId: row.found_candidate_id ? String(row.found_candidate_id) : null,
    evidenceResultId: row.evidence_result_id ? String(row.evidence_result_id) : null,
    legacyTargetStateId: row.legacy_target_state_id ? String(row.legacy_target_state_id) : null,
    legacyFindCandidateResultId: row.legacy_find_candidate_result_id
      ? String(row.legacy_find_candidate_result_id)
      : null,
    candidateKey: String(row.candidate_key),
    status: String(row.status),
    approvalNote: row.approval_note ? String(row.approval_note) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: nullableDate(row.approved_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  } as LandscapeReviewItemCandidateLinkRow;
}

async function updateSqliteCandidateLinkStatusIfCurrent(params: {
  existing: LandscapeReviewItemCandidateLinkRow;
  currentStatus: LandscapeReviewCandidateLinkStatus;
  nextStatus: LandscapeReviewCandidateLinkStatus;
}): Promise<LandscapeReviewItemCandidateLinkRow> {
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `
      update landscape_review_item_candidate_links
      set status = ?,
          updated_at = ?
      where id = ?
        and status = ?
    `,
    )
    .run(
      params.nextStatus,
      new Date().toISOString(),
      params.existing.id,
      params.currentStatus,
    );
  const row = sqlite.db
    .query(`select * from landscape_review_item_candidate_links where id = ? limit 1`)
    .get(params.existing.id) as Record<string, unknown> | null;
  return row ? mapSqliteCandidateLinkRow(row) : params.existing;
}

export async function listLandscapeReviewItemsForCandidateDraft(input: {
  ids?: string[];
  status: "pending" | "reviewing";
  limit: number;
}): Promise<LandscapeReviewItemCandidateSourceRow[]> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const params: unknown[] = [input.status];
    const idFilter =
      input.ids && input.ids.length > 0
        ? `and id in (${input.ids.map(() => "?").join(", ")})`
        : "";
    if (input.ids && input.ids.length > 0) params.push(...input.ids);
    const rows = sqlite.db
      .query(
        `
        select *
        from landscape_review_items
        where status = ?
          and source <> 'contradiction_detection'
          ${idFilter}
        order by priority desc, created_at asc, id asc
        limit ?
      `,
      )
      .all(...params, input.limit) as Record<string, unknown>[];
    return rows.map(mapSqliteReviewItemCandidateSourceRow);
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const existingLink = sqlite.db
      .query(
        `
        select *
        from landscape_review_item_candidate_links
        where review_item_id = ?
          and candidate_key = ?
        limit 1
      `,
      )
      .get(params.reviewItem.id, params.draft.candidateKey) as Record<string, unknown> | null;
    if (existingLink) {
      const link = mapSqliteCandidateLinkRow(existingLink);
      return {
        targetStateId: link.targetStateId,
        findCandidateResultId: link.findCandidateResultId,
        link,
        created: false,
      };
    }

    const now = new Date();
    const nowIso = now.toISOString();
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

    const targetExisting = sqlite.db
      .query(
        `
        select *
        from distillation_target_states
        where target_kind = 'knowledge_candidate'
          and target_key = ?
          and distillation_version = ?
        limit 1
      `,
      )
      .get(params.draft.targetKey, DEFAULT_DISTILLATION_TARGET_VERSION) as
      | { id: string }
      | null;
    const targetStateId = targetExisting?.id ?? crypto.randomUUID();
    if (targetExisting) {
      sqlite.db
        .query(
          `
          update distillation_target_states
          set source_uri = ?,
              priority_group = ?,
              sort_key = ?,
              metadata = ?,
              updated_at = ?
          where id = ?
        `,
        )
        .run(
          sourceUri,
          priorityGroup,
          sortKey,
          JSON.stringify(targetMetadata),
          nowIso,
          targetStateId,
        );
    } else {
      sqlite.db
        .query(
          `
          insert into distillation_target_states (
            id, target_kind, target_key, source_uri, distillation_version, status, phase,
            priority_group, sort_key, metadata, created_at, updated_at
          ) values (?, 'knowledge_candidate', ?, ?, ?, 'pending', 'selected', ?, ?, ?, ?, ?)
        `,
        )
        .run(
          targetStateId,
          params.draft.targetKey,
          sourceUri,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          priorityGroup,
          sortKey,
          JSON.stringify(targetMetadata),
          nowIso,
          nowIso,
        );
    }

    const existingCandidate = sqlite.db
      .query(
        `
        select *
        from find_candidate_results
        where target_state_id = ?
          and candidate_index = 0
        order by created_at asc, id asc
        limit 1
      `,
      )
      .get(targetStateId) as { id: string } | null;
    const findCandidateResultId = existingCandidate?.id ?? crypto.randomUUID();
    if (!existingCandidate) {
      sqlite.db
        .query(
          `
          insert into find_candidate_results (
            id, target_state_id, candidate_index, title, content, origin, status, created_at, updated_at
          ) values (?, ?, 0, ?, ?, ?, 'selected', ?, ?)
        `,
        )
        .run(
          findCandidateResultId,
          targetStateId,
          params.draft.title,
          params.draft.body,
          JSON.stringify({
            source: "landscape_review_item",
            reviewItemId: params.reviewItem.id,
            candidateKey: params.draft.candidateKey,
            candidateType: params.draft.candidateType,
            reason: params.reviewItem.reason,
            proposedAction: params.reviewItem.proposedAction,
            suggestedAppliesTo: params.reviewItem.suggestedAppliesTo,
            evidence: params.reviewItem.evidence,
            generatedAt: params.generatedAt,
          }),
          nowIso,
          nowIso,
        );
    }

    const linkId = crypto.randomUUID();
    sqlite.db
      .query(
        `
        insert into landscape_review_item_candidate_links (
          id, review_item_id, target_state_id, find_candidate_result_id,
          candidate_key, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'draft_created', ?, ?)
      `,
      )
      .run(
        linkId,
        params.reviewItem.id,
        targetStateId,
        findCandidateResultId,
        params.draft.candidateKey,
        nowIso,
        nowIso,
      );

    const payloadPatch = {
      ...((parseJsonValue(params.reviewItem.payload, {}) as Record<string, unknown>) ?? {}),
      lastCandidateTargetStateId: targetStateId,
      lastCandidateResultId: findCandidateResultId,
      lastCandidateCreatedAt: nowIso,
    };
    sqlite.db
      .query(`update landscape_review_items set payload = ?, updated_at = ? where id = ?`)
      .run(JSON.stringify(payloadPatch), nowIso, params.reviewItem.id);

    const link = sqlite.db
      .query(`select * from landscape_review_item_candidate_links where id = ? limit 1`)
      .get(linkId) as Record<string, unknown> | null;
    if (!link) throw new Error("failed to create landscape review candidate link");
    return {
      targetStateId,
      findCandidateResultId,
      link: mapSqliteCandidateLinkRow(link),
      created: true,
    };
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const link = sqlite.db
      .query(`select * from landscape_review_item_candidate_links where find_candidate_result_id = ? limit 1`)
      .get(findCandidateResultId) as Record<string, unknown> | null;
    return link ? mapSqliteCandidateLinkRow(link) : null;
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const link = sqlite.db
      .query(`select * from landscape_review_item_candidate_links where found_candidate_id = ? limit 1`)
      .get(foundCandidateId) as Record<string, unknown> | null;
    return link ? mapSqliteCandidateLinkRow(link) : null;
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const currentRow = sqlite.db
      .query(
        `
        select *
        from landscape_review_item_candidate_links
        where id = ?
          and review_item_id = ?
        limit 1
      `,
      )
      .get(params.linkId, params.reviewItemId) as Record<string, unknown> | null;
    if (!currentRow) return null;
    const current = mapSqliteCandidateLinkRow(currentRow);
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
    const nowIso = new Date().toISOString();
    sqlite.db
      .query(
        `
        update landscape_review_item_candidate_links
        set status = ?,
            approval_note = ?,
            approved_by = ?,
            approved_at = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        nextStatus,
        trimmedNote && trimmedNote.length > 0 ? trimmedNote : null,
        trimmedActor && trimmedActor.length > 0 ? trimmedActor : null,
        nowIso,
        nowIso,
        params.linkId,
      );
    const updated = sqlite.db
      .query(`select * from landscape_review_item_candidate_links where id = ? limit 1`)
      .get(params.linkId) as Record<string, unknown> | null;
    if (!updated) {
      throw new LandscapeReviewCandidateLinkError(400, "failed to update candidate link status");
    }
    return mapSqliteCandidateLinkRow(updated);
  }

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
  if (isSqliteBackend()) {
    return updateSqliteCandidateLinkStatusIfCurrent({
      existing,
      currentStatus: "approved",
      nextStatus: "finalized",
    });
  }

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
  if (isSqliteBackend()) {
    return updateSqliteCandidateLinkStatusIfCurrent({
      existing,
      currentStatus: "approved",
      nextStatus: "finalized",
    });
  }

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
  if (isSqliteBackend()) {
    return updateSqliteCandidateLinkStatusIfCurrent({
      existing,
      currentStatus: "draft_created",
      nextStatus: "review_required",
    });
  }

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
  if (isSqliteBackend()) {
    return updateSqliteCandidateLinkStatusIfCurrent({
      existing,
      currentStatus: "draft_created",
      nextStatus: "review_required",
    });
  }

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
