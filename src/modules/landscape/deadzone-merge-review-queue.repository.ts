import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { deadZoneMergeReviewQueue } from "../../db/schema.js";
import {
  type DeadZoneMergeReviewJob,
  deadZoneMergeReviewJobSchema,
  deadZoneMergeReviewResultSchema,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";

type QueueRow = typeof deadZoneMergeReviewQueue.$inferSelect;

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeResult(value: unknown): DeadZoneMergeReviewJob["result"] {
  const parsed = deadZoneMergeReviewResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mapDeadZoneMergeReviewJob(row: QueueRow): DeadZoneMergeReviewJob {
  return deadZoneMergeReviewJobSchema.parse({
    id: row.id,
    status: row.status,
    deadZoneKnowledgeId: row.deadZoneKnowledgeId,
    canonicalKnowledgeId: row.canonicalKnowledgeId,
    reviewItemId: row.reviewItemId,
    provider: row.provider,
    model: row.model,
    lastError: row.lastError,
    lastOutcomeKind: row.lastOutcomeKind,
    result: normalizeResult(row.result),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: toIso(row.completedAt),
  });
}

export async function upsertDeadZoneMergeReviewJob(params: {
  reviewItemId?: string | null;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  idempotencyKey: string;
  priority: number;
  provider: string;
  model?: string | null;
  inputSnapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<DeadZoneMergeReviewJob> {
  const [row] = await db
    .insert(deadZoneMergeReviewQueue)
    .values({
      reviewItemId: params.reviewItemId ?? null,
      deadZoneKnowledgeId: params.deadZoneKnowledgeId,
      canonicalKnowledgeId: params.canonicalKnowledgeId,
      idempotencyKey: params.idempotencyKey,
      priority: params.priority,
      provider: params.provider,
      model: params.model ?? null,
      inputSnapshot: params.inputSnapshot,
      payload: params.payload,
      metadata: params.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deadZoneMergeReviewQueue.idempotencyKey,
      set: {
        updatedAt: new Date(),
        payload: sql`${deadZoneMergeReviewQueue.payload} || excluded.payload`,
      },
    })
    .returning();
  return mapDeadZoneMergeReviewJob(row);
}

export async function getDeadZoneMergeReviewQueueRow(id: string): Promise<QueueRow | null> {
  const [row] = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(eq(deadZoneMergeReviewQueue.id, id))
    .limit(1);
  return row ?? null;
}

export async function listDeadZoneMergeReviewJobs(params: {
  status?: string;
  deadZoneKnowledgeId?: string;
  canonicalKnowledgeId?: string;
  reviewItemId?: string;
  limit?: number;
}): Promise<DeadZoneMergeReviewJob[]> {
  const filters = [];
  if (params.status && params.status !== "all")
    filters.push(eq(deadZoneMergeReviewQueue.status, params.status));
  if (params.deadZoneKnowledgeId) {
    filters.push(eq(deadZoneMergeReviewQueue.deadZoneKnowledgeId, params.deadZoneKnowledgeId));
  }
  if (params.canonicalKnowledgeId) {
    filters.push(eq(deadZoneMergeReviewQueue.canonicalKnowledgeId, params.canonicalKnowledgeId));
  }
  if (params.reviewItemId)
    filters.push(eq(deadZoneMergeReviewQueue.reviewItemId, params.reviewItemId));

  const rows = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(deadZoneMergeReviewQueue.updatedAt))
    .limit(Math.max(1, Math.min(100, params.limit ?? 50)));
  return rows.map(mapDeadZoneMergeReviewJob);
}

export async function listLatestDeadZoneMergeReviewJobsByDeadZoneIds(
  ids: string[],
): Promise<Map<string, DeadZoneMergeReviewJob>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const result = new Map<string, DeadZoneMergeReviewJob>();
  if (uniqueIds.length === 0) return result;
  const rows = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(inArray(deadZoneMergeReviewQueue.deadZoneKnowledgeId, uniqueIds));
  rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  for (const row of rows) {
    if (!result.has(row.deadZoneKnowledgeId)) {
      result.set(row.deadZoneKnowledgeId, mapDeadZoneMergeReviewJob(row));
    }
  }
  return result;
}

export async function markDeadZoneMergeReviewJobCompleted(params: {
  id: string;
  result: Record<string, unknown>;
  outcome: string;
}): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(params.id);
  await db
    .update(deadZoneMergeReviewQueue)
    .set({
      status: "completed",
      attemptCount: (row?.attemptCount ?? 0) + 1,
      result: params.result,
      lastError: null,
      lastOutcomeKind: params.outcome,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deadZoneMergeReviewQueue.id, params.id));
}

export async function markDeadZoneMergeReviewJobSkipped(params: {
  id: string;
  reason: string;
  result?: Record<string, unknown>;
}): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(params.id);
  await db
    .update(deadZoneMergeReviewQueue)
    .set({
      status: "skipped",
      attemptCount: (row?.attemptCount ?? 0) + 1,
      result: params.result ?? {},
      lastError: params.reason.slice(0, 2000),
      lastOutcomeKind: "skipped",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deadZoneMergeReviewQueue.id, params.id));
}

export async function markDeadZoneMergeReviewJobFailed(params: {
  id: string;
  error: string;
  outcome: string;
}): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(params.id);
  await db
    .update(deadZoneMergeReviewQueue)
    .set({
      status: "failed",
      attemptCount: (row?.attemptCount ?? 0) + 1,
      lastError: params.error.slice(0, 2000),
      lastOutcomeKind: params.outcome,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    })
    .where(eq(deadZoneMergeReviewQueue.id, params.id));
}
