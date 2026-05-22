import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contextCompileRuns,
  contextPackItems,
  knowledgeReviewQueue,
  knowledgeUsageEvents,
} from "../../db/schema.js";
import type { CompileRunKnowledgeFeedbackResult } from "../../shared/schemas/compile-run.schema.js";
import { recalculateKnowledgeDynamicScoresSafe } from "./knowledge-value.service.js";

type KnowledgeUsageVerdict = "used" | "off_topic" | "wrong";
type FeedbackActor = "agent" | "user" | "system";

type RecordCompileRunKnowledgeFeedbackInput = {
  runId: string;
  items: Array<{
    knowledgeId: string;
    verdict: KnowledgeUsageVerdict;
    reason?: string;
  }>;
  actor?: FeedbackActor;
};

type ExistingFeedbackEvent = {
  id: string;
  knowledgeId: string;
  verdict: KnowledgeUsageVerdict;
  reason: string | null;
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
      reason: knowledgeUsageEvents.reason,
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
    if (row.verdict !== "used" && row.verdict !== "off_topic" && row.verdict !== "wrong") continue;
    map.set(row.knowledgeId, {
      id: row.id,
      knowledgeId: row.knowledgeId,
      verdict: row.verdict,
      reason: typeof row.reason === "string" ? row.reason : null,
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

export async function recordCompileRunKnowledgeFeedback(
  input: RecordCompileRunKnowledgeFeedbackInput,
): Promise<CompileRunKnowledgeFeedbackResult> {
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

    if (existing) {
      eventId = existing.id;
      previousVerdict = existing.verdict;
      const hasChanged = existing.verdict !== item.verdict || existing.reason !== item.reason;
      if (hasChanged) {
        await db
          .update(knowledgeUsageEvents)
          .set({
            verdict: item.verdict,
            actor,
            reason: item.reason,
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
          metadata: {},
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
