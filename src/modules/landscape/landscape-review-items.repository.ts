import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { landscapeReviewItems } from "../../db/schema.js";
import type {
  LandscapeReviewItemInsert,
  ListLandscapeReviewItemsInput,
} from "./landscape-review-items.types.js";

export type LandscapeReviewItemRow = typeof landscapeReviewItems.$inferSelect;

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

function mapSqliteReviewItemRow(row: Record<string, unknown>): LandscapeReviewItemRow {
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
  } as LandscapeReviewItemRow;
}

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

  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const inserted: LandscapeReviewItemRow[] = [];
    const existing: LandscapeReviewItemRow[] = [];
    const now = new Date().toISOString();

    for (const candidate of candidates) {
      const current = sqlite.db
        .query("select * from landscape_review_items where idempotency_key = ? limit 1")
        .get(candidate.idempotencyKey) as Record<string, unknown> | null;
      if (current) {
        existing.push(mapSqliteReviewItemRow(current));
        continue;
      }

      const id = crypto.randomUUID();
      sqlite.db
        .query(
          `
          insert into landscape_review_items (
            id, source, reason, status, proposed_action, priority, confidence, idempotency_key,
            knowledge_id, run_id, trigger_event_id, community_key, community_label,
            suggested_applies_to, evidence, payload, note, created_at, updated_at, resolved_at
          ) values (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
        `,
        )
        .run(
          id,
          candidate.source,
          candidate.reason,
          candidate.proposedAction,
          candidate.priority,
          candidate.confidence,
          candidate.idempotencyKey,
          candidate.knowledgeId,
          candidate.runId,
          candidate.triggerEventId,
          candidate.communityKey,
          candidate.communityLabel,
          JSON.stringify(candidate.suggestedAppliesTo),
          JSON.stringify(candidate.evidence),
          JSON.stringify(candidate.payload),
          candidate.note ?? null,
          now,
          now,
        );
      const row = sqlite.db
        .query("select * from landscape_review_items where id = ? limit 1")
        .get(id) as Record<string, unknown> | null;
      if (row) inserted.push(mapSqliteReviewItemRow(row));
    }

    return { inserted, existing };
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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const conditions = ["priority >= ?"];
    const values: unknown[] = [input.priorityMin];
    if (input.status !== "all") {
      conditions.push("status = ?");
      values.push(input.status);
    }
    if (input.source !== "all") {
      conditions.push("source = ?");
      values.push(input.source);
    }
    if (input.reason !== "all") {
      conditions.push("reason = ?");
      values.push(input.reason);
    }
    if (input.proposedAction !== "all") {
      conditions.push("proposed_action = ?");
      values.push(input.proposedAction);
    }
    if (input.knowledgeId) {
      conditions.push("knowledge_id = ?");
      values.push(input.knowledgeId);
    }
    if (input.runId) {
      conditions.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.communityKey) {
      conditions.push("community_key = ?");
      values.push(input.communityKey);
    }

    const rows = sqlite.db
      .query(
        `
        select *
        from landscape_review_items
        where ${conditions.join(" and ")}
        order by priority desc, created_at asc, id asc
        limit ?
      `,
      )
      .all(...values, input.limit) as Record<string, unknown>[];
    return rows.map(mapSqliteReviewItemRow);
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const conditions = ["priority >= ?"];
    const values: unknown[] = [input.priorityMin];
    if (input.status !== "all") {
      conditions.push("status = ?");
      values.push(input.status);
    }
    if (input.source !== "all") {
      conditions.push("source = ?");
      values.push(input.source);
    }
    if (input.reason !== "all") {
      conditions.push("reason = ?");
      values.push(input.reason);
    }
    if (input.proposedAction !== "all") {
      conditions.push("proposed_action = ?");
      values.push(input.proposedAction);
    }
    if (input.knowledgeId) {
      conditions.push("knowledge_id = ?");
      values.push(input.knowledgeId);
    }
    if (input.runId) {
      conditions.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.communityKey) {
      conditions.push("community_key = ?");
      values.push(input.communityKey);
    }

    const row = sqlite.db
      .query(
        `select count(*) as count from landscape_review_items where ${conditions.join(" and ")}`,
      )
      .get(...values) as { count?: number } | null;
    return Number(row?.count ?? 0);
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query("select * from landscape_review_items where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    return row ? mapSqliteReviewItemRow(row) : null;
  }

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
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const current = sqlite.db
      .query("select * from landscape_review_items where id = ? limit 1")
      .get(input.id) as Record<string, unknown> | null;
    if (!current) return null;

    const nextNote =
      input.note === undefined
        ? (current.note ?? null)
        : input.note.trim().length > 0
          ? input.note
          : null;
    sqlite.db
      .query(
        `
        update landscape_review_items
        set status = ?, note = ?, resolved_at = ?, updated_at = ?
        where id = ?
      `,
      )
      .run(
        input.status,
        nextNote,
        input.resolvedAt ? input.resolvedAt.toISOString() : null,
        input.updatedAt.toISOString(),
        input.id,
      );
    const row = sqlite.db
      .query("select * from landscape_review_items where id = ? limit 1")
      .get(input.id) as Record<string, unknown> | null;
    return row ? mapSqliteReviewItemRow(row) : null;
  }

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
