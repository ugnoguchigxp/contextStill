import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { landscapeReviewItems } from "../../db/schema.js";
import type {
  LandscapeReviewItemInsert,
  ListLandscapeReviewItemsInput,
} from "./landscape-review-items.types.js";

export type LandscapeReviewItemRow = typeof landscapeReviewItems.$inferSelect;

function asInsertRows(candidates: LandscapeReviewItemInsert[]) {
  return candidates.map((candidate) => ({
    source: candidate.source,
    reason: candidate.reason,
    status: "pending" as const,
    proposedAction: candidate.proposedAction,
    priority: candidate.priority,
    confidence: candidate.confidence,
    idempotencyKey: candidate.idempotencyKey,
    knowledgeId: candidate.knowledgeId,
    runId: candidate.runId,
    triggerEventId: candidate.triggerEventId,
    communityKey: candidate.communityKey,
    communityLabel: candidate.communityLabel,
    suggestedAppliesTo: candidate.suggestedAppliesTo,
    evidence: candidate.evidence,
    payload: candidate.payload,
    note: candidate.note ?? null,
  }));
}

export async function insertLandscapeReviewItemsIdempotent(
  candidates: LandscapeReviewItemInsert[],
): Promise<{
  inserted: LandscapeReviewItemRow[];
  existing: LandscapeReviewItemRow[];
}> {
  if (candidates.length === 0) {
    return {
      inserted: [],
      existing: [],
    };
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(landscapeReviewItems)
      .values(asInsertRows(candidates))
      .onConflictDoNothing({
        target: landscapeReviewItems.idempotencyKey,
      })
      .returning();

    const keys = [...new Set(candidates.map((candidate) => candidate.idempotencyKey))];
    const allRows = await tx
      .select()
      .from(landscapeReviewItems)
      .where(inArray(landscapeReviewItems.idempotencyKey, keys));

    const insertedIds = new Set(inserted.map((row) => row.id));
    const existing = allRows.filter((row) => !insertedIds.has(row.id));

    return {
      inserted,
      existing,
    };
  });
}

export async function listLandscapeReviewItemRows(
  input: ListLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemRow[]> {
  const conditions = [gte(landscapeReviewItems.priority, input.priorityMin)];
  if (input.status !== "all") {
    conditions.push(eq(landscapeReviewItems.status, input.status));
  }
  if (input.source !== "all") {
    conditions.push(eq(landscapeReviewItems.source, input.source));
  }
  if (input.reason !== "all") {
    conditions.push(eq(landscapeReviewItems.reason, input.reason));
  }
  if (input.proposedAction !== "all") {
    conditions.push(eq(landscapeReviewItems.proposedAction, input.proposedAction));
  }
  if (input.knowledgeId) {
    conditions.push(eq(landscapeReviewItems.knowledgeId, input.knowledgeId));
  }
  if (input.runId) {
    conditions.push(eq(landscapeReviewItems.runId, input.runId));
  }
  if (input.communityKey) {
    conditions.push(eq(landscapeReviewItems.communityKey, input.communityKey));
  }

  return db
    .select()
    .from(landscapeReviewItems)
    .where(and(...conditions))
    .orderBy(
      desc(landscapeReviewItems.priority),
      asc(landscapeReviewItems.createdAt),
      asc(landscapeReviewItems.id),
    )
    .limit(input.limit);
}

export async function countLandscapeReviewItemRows(
  input: ListLandscapeReviewItemsInput,
): Promise<number> {
  const conditions = [gte(landscapeReviewItems.priority, input.priorityMin)];
  if (input.status !== "all") {
    conditions.push(eq(landscapeReviewItems.status, input.status));
  }
  if (input.source !== "all") {
    conditions.push(eq(landscapeReviewItems.source, input.source));
  }
  if (input.reason !== "all") {
    conditions.push(eq(landscapeReviewItems.reason, input.reason));
  }
  if (input.proposedAction !== "all") {
    conditions.push(eq(landscapeReviewItems.proposedAction, input.proposedAction));
  }
  if (input.knowledgeId) {
    conditions.push(eq(landscapeReviewItems.knowledgeId, input.knowledgeId));
  }
  if (input.runId) {
    conditions.push(eq(landscapeReviewItems.runId, input.runId));
  }
  if (input.communityKey) {
    conditions.push(eq(landscapeReviewItems.communityKey, input.communityKey));
  }

  const [result] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(landscapeReviewItems)
    .where(and(...conditions));

  return Number(result?.count ?? 0);
}

export async function findLandscapeReviewItemRowById(
  id: string,
): Promise<LandscapeReviewItemRow | null> {
  const [row] = await db
    .select()
    .from(landscapeReviewItems)
    .where(eq(landscapeReviewItems.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateLandscapeReviewItemRow(input: {
  id: string;
  status: LandscapeReviewItemRow["status"];
  note?: string;
  resolvedAt: Date | null;
  updatedAt: Date;
}): Promise<LandscapeReviewItemRow | null> {
  const updateValues: Partial<typeof landscapeReviewItems.$inferInsert> = {
    status: input.status,
    updatedAt: input.updatedAt,
    resolvedAt: input.resolvedAt,
  };
  if (input.note !== undefined) {
    updateValues.note = input.note.trim().length > 0 ? input.note : null;
  }

  const [row] = await db
    .update(landscapeReviewItems)
    .set(updateValues)
    .where(eq(landscapeReviewItems.id, input.id))
    .returning();

  return row ?? null;
}
