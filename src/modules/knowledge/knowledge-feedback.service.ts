import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  contextCompileRuns,
  contextPackItems,
  knowledgeReviewQueue,
  knowledgeUsageEvents,
} from "../../db/schema.js";
import type { CompileRunKnowledgeFeedbackResult } from "../../shared/schemas/compile-run.schema.js";
import { recalculateKnowledgeDynamicScoresSafe } from "./knowledge-value.service.js";

type KnowledgeUsageVerdict = "used" | "not_used" | "off_topic" | "wrong";
type FeedbackActor = "agent" | "user" | "system";
type FeedbackMetadata = Record<string, unknown>;

type RecordCompileRunKnowledgeFeedbackInput = {
  runId: string;
  items: Array<{
    knowledgeId: string;
    verdict: KnowledgeUsageVerdict;
    reason?: string;
    metadata?: FeedbackMetadata;
  }>;
  actor?: FeedbackActor;
};

type RecordCompileRunKnowledgeUsageSignalsInput = {
  runId: string;
  items: Array<{
    knowledgeId: string;
    verdict: "used" | "not_used";
    reason?: string;
    metadata?: FeedbackMetadata;
  }>;
  actor?: Exclude<FeedbackActor, "user">;
};

type ExistingFeedbackEvent = {
  id: string;
  knowledgeId: string;
  verdict: KnowledgeUsageVerdict;
  actor: FeedbackActor;
  reason: string | null;
  metadata: FeedbackMetadata;
  updatedAt: Date;
};

export class CompileRunKnowledgeFeedbackError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "CompileRunKnowledgeFeedbackError";
    this.statusCode = statusCode;
  }
}

function normalizeReason(reason: string | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMetadata(metadata: unknown): FeedbackMetadata {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as FeedbackMetadata;
  }
  return {};
}

function isKnowledgeUsageVerdict(value: unknown): value is KnowledgeUsageVerdict {
  return value === "used" || value === "not_used" || value === "off_topic" || value === "wrong";
}

async function assertCompileRunExists(runId: string): Promise<void> {
  const [run] = await db
    .select({ id: contextCompileRuns.id })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new CompileRunKnowledgeFeedbackError(404, "Compile run not found.");
  }
}

async function loadSelectableKnowledgeIds(runId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      itemId: contextPackItems.itemId,
    })
    .from(contextPackItems)
    .where(
      and(
        eq(contextPackItems.runId, runId),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
      ),
    );
  return new Set(rows.map((row) => row.itemId.trim()).filter((itemId) => itemId.length > 0));
}

async function loadExistingFeedbackEvents(
  runId: string,
  knowledgeIds: string[],
): Promise<Map<string, ExistingFeedbackEvent>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: knowledgeUsageEvents.id,
      knowledgeId: knowledgeUsageEvents.knowledgeId,
      verdict: knowledgeUsageEvents.verdict,
      actor: knowledgeUsageEvents.actor,
      reason: knowledgeUsageEvents.reason,
      metadata: knowledgeUsageEvents.metadata,
      updatedAt: knowledgeUsageEvents.updatedAt,
    })
    .from(knowledgeUsageEvents)
    .where(
      and(
        eq(knowledgeUsageEvents.runId, runId),
        inArray(knowledgeUsageEvents.knowledgeId, knowledgeIds),
      ),
    );
  const map = new Map<string, ExistingFeedbackEvent>();
  for (const row of rows) {
    if (!isKnowledgeUsageVerdict(row.verdict)) continue;
    if (row.actor !== "agent" && row.actor !== "user" && row.actor !== "system") continue;
    map.set(row.knowledgeId, {
      id: row.id,
      knowledgeId: row.knowledgeId,
      verdict: row.verdict,
      actor: row.actor,
      reason: typeof row.reason === "string" ? row.reason : null,
      metadata: normalizeMetadata(row.metadata),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(0),
    });
  }
  return map;
}

async function enqueueWrongReviewQueue(params: {
  knowledgeId: string;
  triggerEventId: string;
  now: Date;
}): Promise<number> {
  const unresolved = await db
    .select({ id: knowledgeReviewQueue.id })
    .from(knowledgeReviewQueue)
    .where(
      and(
        eq(knowledgeReviewQueue.knowledgeId, params.knowledgeId),
        inArray(knowledgeReviewQueue.status, ["pending", "reviewing"]),
      ),
    )
    .limit(1);
  if (unresolved.length > 0) return 0;

  await db.insert(knowledgeReviewQueue).values({
    knowledgeId: params.knowledgeId,
    triggerEventId: params.triggerEventId,
    triggerVerdict: "wrong",
    status: "pending",
    proposedAction: "demote_to_draft_candidate",
    createdAt: params.now,
    updatedAt: params.now,
  });
  return 1;
}

async function dismissPendingQueueByEvent(params: {
  triggerEventId: string;
  now: Date;
}): Promise<number> {
  const rows = await db
    .update(knowledgeReviewQueue)
    .set({
      status: "dismissed",
      updatedAt: params.now,
    })
    .where(
      and(
        eq(knowledgeReviewQueue.triggerEventId, params.triggerEventId),
        eq(knowledgeReviewQueue.status, "pending"),
      ),
    )
    .returning({ id: knowledgeReviewQueue.id });
  return rows.length;
}

async function recordCompileRunKnowledgeFeedbackSqlite(
  input: RecordCompileRunKnowledgeFeedbackInput,
): Promise<CompileRunKnowledgeFeedbackResult> {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const run = sqlite.db
    .query<{ id: string }, [string]>("SELECT id FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(input.runId);
  if (!run) {
    throw new CompileRunKnowledgeFeedbackError(404, "Compile run not found.");
  }

  const actor: FeedbackActor = input.actor ?? "user";
  const seenKnowledgeIds = new Set<string>();
  const normalizedItems = input.items.map((item) => {
    const knowledgeId = item.knowledgeId.trim();
    if (seenKnowledgeIds.has(knowledgeId)) {
      throw new CompileRunKnowledgeFeedbackError(
        400,
        `Duplicate knowledgeId in request: ${knowledgeId}`,
      );
    }
    seenKnowledgeIds.add(knowledgeId);
    return {
      knowledgeId,
      verdict: item.verdict,
      reason: normalizeReason(item.reason),
      metadata: normalizeMetadata(item.metadata),
    };
  });

  const selectableRows = sqlite.db
    .query<{ item_id: string }, [string]>(
      `SELECT item_id
       FROM context_pack_items
       WHERE run_id = ? AND item_kind IN ('rule', 'procedure')`,
    )
    .all(input.runId);
  const selectableKnowledgeIds = new Set(
    selectableRows.map((row) => row.item_id.trim()).filter((itemId) => itemId.length > 0),
  );
  const invalidKnowledgeIds = normalizedItems
    .map((item) => item.knowledgeId)
    .filter((knowledgeId) => !selectableKnowledgeIds.has(knowledgeId));
  if (invalidKnowledgeIds.length > 0) {
    throw new CompileRunKnowledgeFeedbackError(
      400,
      `Knowledge IDs are not in selected items for this run: ${invalidKnowledgeIds.join(", ")}`,
    );
  }

  const existingFeedbackMap = new Map<string, ExistingFeedbackEvent>();
  if (normalizedItems.length > 0) {
    const knowledgeIds = normalizedItems.map((item) => item.knowledgeId);
    const rows = sqlite.db
      .query<
        {
          id: string;
          knowledge_id: string;
          verdict: string;
          actor: string;
          reason: string | null;
          metadata: string;
          updated_at: string;
        },
        string[]
      >(
        `SELECT id, knowledge_id, verdict, actor, reason, metadata, updated_at
         FROM knowledge_usage_events
         WHERE run_id = ? AND knowledge_id IN (${knowledgeIds.map(() => "?").join(", ")})`,
      )
      .all(input.runId, ...knowledgeIds);
    for (const row of rows) {
      if (!isKnowledgeUsageVerdict(row.verdict)) continue;
      if (row.actor !== "agent" && row.actor !== "user" && row.actor !== "system") continue;
      let metadata: FeedbackMetadata = {};
      try {
        metadata = normalizeMetadata(JSON.parse(row.metadata));
      } catch {
        metadata = {};
      }
      existingFeedbackMap.set(row.knowledge_id, {
        id: row.id,
        knowledgeId: row.knowledge_id,
        verdict: row.verdict,
        actor: row.actor,
        reason: typeof row.reason === "string" ? row.reason : null,
        metadata,
        updatedAt: new Date(row.updated_at),
      });
    }
  }

  let savedCount = 0;
  let updatedCount = 0;
  let queueCreatedCount = 0;
  let queueDismissedCount = 0;
  const affectedKnowledgeIds = new Set<string>();
  const now = new Date();
  const nowIso = now.toISOString();

  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of normalizedItems) {
      const existing = existingFeedbackMap.get(item.knowledgeId);
      let eventId: string;
      let previousVerdict: KnowledgeUsageVerdict | null = null;
      let nextMetadata = item.metadata;

      if (existing) {
        eventId = existing.id;
        previousVerdict = existing.verdict;
        if (actor === "user" && existing.actor !== "user") {
          nextMetadata = {
            ...existing.metadata,
            ...item.metadata,
            autoVerdict: existing.verdict,
            autoActor: existing.actor,
            autoReason: existing.reason,
            autoUpdatedAt: existing.updatedAt.toISOString(),
          };
        } else if (Object.keys(nextMetadata).length === 0) {
          nextMetadata = existing.metadata;
        }
        const hasChanged = existing.verdict !== item.verdict || existing.reason !== item.reason;
        if (hasChanged) {
          sqlite.db
            .query(
              `UPDATE knowledge_usage_events
               SET verdict = ?, actor = ?, reason = ?, metadata = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(item.verdict, actor, item.reason, JSON.stringify(nextMetadata), nowIso, eventId);
          savedCount += 1;
          updatedCount += 1;
        }
      } else {
        eventId = randomUUID();
        sqlite.db
          .query(
            `INSERT INTO knowledge_usage_events (
              id, run_id, knowledge_id, verdict, actor, reason, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            input.runId,
            item.knowledgeId,
            item.verdict,
            actor,
            item.reason,
            JSON.stringify(nextMetadata),
            nowIso,
            nowIso,
          );
        savedCount += 1;
      }

      if (item.verdict === "wrong") {
        const unresolved = sqlite.db
          .query<{ id: string }, [string]>(
            `SELECT id FROM knowledge_review_queue
             WHERE knowledge_id = ? AND status IN ('pending', 'reviewing')
             LIMIT 1`,
          )
          .get(item.knowledgeId);
        if (!unresolved) {
          sqlite.db
            .query(
              `INSERT INTO knowledge_review_queue (
                id, knowledge_id, trigger_event_id, trigger_verdict, status,
                proposed_action, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'pending', 'demote_to_draft_candidate', ?, ?)`,
            )
            .run(randomUUID(), item.knowledgeId, eventId, "wrong", nowIso, nowIso);
          queueCreatedCount += 1;
        }
      } else if (previousVerdict === "wrong") {
        const result = sqlite.db
          .query(
            `UPDATE knowledge_review_queue
             SET status = 'dismissed', updated_at = ?
             WHERE trigger_event_id = ? AND status = 'pending'`,
          )
          .run(nowIso, eventId);
        queueDismissedCount += result.changes;
      }

      affectedKnowledgeIds.add(item.knowledgeId);
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }

  const affectedIds = [...affectedKnowledgeIds];
  await recalculateKnowledgeDynamicScoresSafe(affectedIds);

  return {
    savedCount,
    updatedCount,
    queueCreatedCount,
    queueDismissedCount,
    affectedKnowledgeIds: affectedIds,
  };
}

export async function recordCompileRunKnowledgeFeedback(
  input: RecordCompileRunKnowledgeFeedbackInput,
): Promise<CompileRunKnowledgeFeedbackResult> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return recordCompileRunKnowledgeFeedbackSqlite(input);
  }
  await assertCompileRunExists(input.runId);
  const actor: FeedbackActor = input.actor ?? "user";

  const seenKnowledgeIds = new Set<string>();
  const normalizedItems = input.items.map((item) => {
    const knowledgeId = item.knowledgeId.trim();
    if (seenKnowledgeIds.has(knowledgeId)) {
      throw new CompileRunKnowledgeFeedbackError(
        400,
        `Duplicate knowledgeId in request: ${knowledgeId}`,
      );
    }
    seenKnowledgeIds.add(knowledgeId);
    return {
      knowledgeId,
      verdict: item.verdict,
      reason: normalizeReason(item.reason),
      metadata: normalizeMetadata(item.metadata),
    };
  });

  const selectableKnowledgeIds = await loadSelectableKnowledgeIds(input.runId);
  const invalidKnowledgeIds = normalizedItems
    .map((item) => item.knowledgeId)
    .filter((knowledgeId) => !selectableKnowledgeIds.has(knowledgeId));
  if (invalidKnowledgeIds.length > 0) {
    throw new CompileRunKnowledgeFeedbackError(
      400,
      `Knowledge IDs are not in selected items for this run: ${invalidKnowledgeIds.join(", ")}`,
    );
  }

  const existingFeedbackMap = await loadExistingFeedbackEvents(
    input.runId,
    normalizedItems.map((item) => item.knowledgeId),
  );

  let savedCount = 0;
  let updatedCount = 0;
  let queueCreatedCount = 0;
  let queueDismissedCount = 0;
  const affectedKnowledgeIds = new Set<string>();
  const now = new Date();

  for (const item of normalizedItems) {
    const existing = existingFeedbackMap.get(item.knowledgeId);
    let eventId: string;
    let previousVerdict: KnowledgeUsageVerdict | null = null;
    let nextMetadata = item.metadata;

    if (existing) {
      eventId = existing.id;
      previousVerdict = existing.verdict;
      if (actor === "user" && existing.actor !== "user") {
        nextMetadata = {
          ...existing.metadata,
          ...item.metadata,
          autoVerdict: existing.verdict,
          autoActor: existing.actor,
          autoReason: existing.reason,
          autoUpdatedAt: existing.updatedAt.toISOString(),
        };
      } else if (Object.keys(nextMetadata).length === 0) {
        nextMetadata = existing.metadata;
      }
      const hasChanged = existing.verdict !== item.verdict || existing.reason !== item.reason;
      if (hasChanged) {
        await db
          .update(knowledgeUsageEvents)
          .set({
            verdict: item.verdict,
            actor,
            reason: item.reason,
            metadata: nextMetadata,
            updatedAt: now,
          })
          .where(eq(knowledgeUsageEvents.id, eventId));
        savedCount += 1;
        updatedCount += 1;
      }
    } else {
      const [inserted] = await db
        .insert(knowledgeUsageEvents)
        .values({
          runId: input.runId,
          knowledgeId: item.knowledgeId,
          verdict: item.verdict,
          actor,
          reason: item.reason,
          metadata: nextMetadata,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: knowledgeUsageEvents.id });
      eventId = inserted.id;
      savedCount += 1;
    }

    if (item.verdict === "wrong") {
      queueCreatedCount += await enqueueWrongReviewQueue({
        knowledgeId: item.knowledgeId,
        triggerEventId: eventId,
        now,
      });
    } else if (previousVerdict === "wrong") {
      queueDismissedCount += await dismissPendingQueueByEvent({
        triggerEventId: eventId,
        now,
      });
    }

    affectedKnowledgeIds.add(item.knowledgeId);
  }

  const affectedIds = [...affectedKnowledgeIds];
  await recalculateKnowledgeDynamicScoresSafe(affectedIds);

  return {
    savedCount,
    updatedCount,
    queueCreatedCount,
    queueDismissedCount,
    affectedKnowledgeIds: affectedIds,
  };
}

export async function recordCompileRunKnowledgeUsageSignals(
  input: RecordCompileRunKnowledgeUsageSignalsInput,
): Promise<CompileRunKnowledgeFeedbackResult> {
  return recordCompileRunKnowledgeFeedback({
    runId: input.runId,
    actor: input.actor ?? "agent",
    items: input.items.map((item) => ({
      knowledgeId: item.knowledgeId,
      verdict: item.verdict,
      reason: item.reason,
      metadata: item.metadata,
    })),
  });
}
