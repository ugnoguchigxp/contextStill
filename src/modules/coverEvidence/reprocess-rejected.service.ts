import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  coverEvidenceResults,
  distillationTargetStates,
  findCandidateResults,
  knowledgeItems,
} from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";

export type ReprocessRejectedInput = {
  reason?: string;
  candidateType?: "rule" | "procedure";
  source?: string;
  limit?: number;
  apply?: boolean;
  allowCompleted?: boolean;
};

export type ReprocessRejectedItem = {
  targetStateId: string;
  findCandidateResultId: string;
  coverEvidenceResultId: string;
  title: string;
  originalType: string | null;
  targetStatus: string;
  targetPhase: string;
  currentStatus: string;
  currentStage: string;
  currentReason: string | null;
  updatedAt: string;
  proposedAction:
    | "mark_reprocess_requested"
    | "requeue_target"
    | "skip_already_requested"
    | "skip_completed"
    | "skip_running"
    | "skip_knowledge_exists";
  applied: boolean;
};

export type ReprocessRejectedResult = {
  apply: boolean;
  matched: number;
  updated: number;
  items: ReprocessRejectedItem[];
};

function positiveLimit(value: number | undefined): number {
  return Math.max(1, Math.min(500, Math.floor(value ?? 20)));
}

function prefixedReason(reason: string | null): string {
  const value = reason?.trim() || "unspecified";
  return (value.startsWith("reprocess_requested:") ? value : `reprocess_requested:${value}`).slice(
    0,
    160,
  );
}

function actionFor(row: {
  currentStatus: string;
  targetStatus: string;
  knowledgeId: string | null;
  allowCompleted?: boolean;
}): ReprocessRejectedItem["proposedAction"] {
  if (row.knowledgeId) return "skip_knowledge_exists";
  if (row.currentStatus === "reprocess_requested") return "skip_already_requested";
  if (row.targetStatus === "running") return "skip_running";
  if (row.targetStatus === "completed" && !row.allowCompleted) return "skip_completed";
  if (row.targetStatus === "pending") return "mark_reprocess_requested";
  return "requeue_target";
}

function rowToItem(
  row: {
    targetStateId: string;
    findCandidateResultId: string;
    title: string;
    originalType: string | null;
    targetStatus: string;
    targetPhase: string;
    currentStatus: string;
    currentStage: string;
    currentReason: string | null;
    updatedAt: Date;
    knowledgeId: string | null;
  },
  allowCompleted?: boolean,
): ReprocessRejectedItem {
  return {
    targetStateId: row.targetStateId,
    findCandidateResultId: row.findCandidateResultId,
    coverEvidenceResultId: row.findCandidateResultId,
    title: row.title,
    originalType: row.originalType,
    targetStatus: row.targetStatus,
    targetPhase: row.targetPhase,
    currentStatus: row.currentStatus,
    currentStage: row.currentStage,
    currentReason: row.currentReason,
    updatedAt: row.updatedAt.toISOString(),
    proposedAction: actionFor({ ...row, allowCompleted }),
    applied: false,
  };
}

export async function reprocessRejectedCandidates(
  input: ReprocessRejectedInput,
): Promise<ReprocessRejectedResult> {
  const limit = positiveLimit(input.limit);
  const reason = input.reason?.trim() || "procedure_body_not_actionable";
  const source = input.source?.trim();
  const candidateType = input.candidateType;
  const rows = await db
    .select({
      targetStateId: distillationTargetStates.id,
      findCandidateResultId: findCandidateResults.id,
      title: findCandidateResults.title,
      originalType: sql<
        string | null
      >`coalesce(${findCandidateResults.origin}->>'candidateType', ${findCandidateResults.origin}->>'typeHint', ${findCandidateResults.origin}->>'type')`,
      targetStatus: distillationTargetStates.status,
      targetPhase: distillationTargetStates.phase,
      currentStatus: coverEvidenceResults.status,
      currentStage: coverEvidenceResults.stage,
      currentReason: coverEvidenceResults.reason,
      updatedAt: coverEvidenceResults.updatedAt,
      knowledgeId: knowledgeItems.id,
    })
    .from(coverEvidenceResults)
    .innerJoin(findCandidateResults, eq(findCandidateResults.id, coverEvidenceResults.id))
    .innerJoin(
      distillationTargetStates,
      eq(distillationTargetStates.id, findCandidateResults.targetStateId),
    )
    .leftJoin(
      knowledgeItems,
      sql`${knowledgeItems.metadata}->>'coverEvidenceResultId' = ${coverEvidenceResults.id}::text`,
    )
    .where(
      and(
        sql`${coverEvidenceResults.status} in ('insufficient', 'reprocess_requested')`,
        sql`(${coverEvidenceResults.reason} = ${reason} or ${coverEvidenceResults.reason} = ${prefixedReason(reason)})`,
        eq(findCandidateResults.status, "selected"),
        candidateType
          ? sql`coalesce(${findCandidateResults.origin}->>'candidateType', ${findCandidateResults.origin}->>'typeHint', ${findCandidateResults.origin}->>'type') = ${candidateType}`
          : sql`true`,
        source ? sql`${distillationTargetStates.sourceUri} like ${`${source}%`}` : sql`true`,
      ),
    )
    .orderBy(coverEvidenceResults.updatedAt)
    .limit(limit);

  const items = rows.map((row) => rowToItem(row, input.allowCompleted));
  if (!input.apply) {
    return {
      apply: false,
      matched: items.length,
      updated: 0,
      items,
    };
  }

  let updated = 0;
  const requestedAt = new Date();
  for (const item of items) {
    if (
      item.proposedAction === "skip_already_requested" ||
      item.proposedAction === "skip_running" ||
      item.proposedAction === "skip_knowledge_exists" ||
      (item.proposedAction === "skip_completed" && !input.allowCompleted)
    ) {
      continue;
    }

    const applied = await db.transaction(async (tx) => {
      const updatedRows = await tx
        .update(coverEvidenceResults)
        .set({
          status: "reprocess_requested",
          reason: prefixedReason(item.currentReason),
          toolEvents: sql`${coverEvidenceResults.toolEvents} || ${JSON.stringify([
            {
              name: "reprocess_rejected_candidate",
              ok: true,
              metadata: {
                previousStatus: item.currentStatus,
                previousStage: item.currentStage,
                previousReason: item.currentReason,
                requestedAt: requestedAt.toISOString(),
                reason,
              },
            },
          ])}::jsonb` as never,
          updatedAt: requestedAt,
        })
        .where(
          and(
            eq(coverEvidenceResults.id, item.coverEvidenceResultId),
            eq(coverEvidenceResults.status, "insufficient"),
            isNotNull(coverEvidenceResults.reason),
          ),
        )
        .returning({ id: coverEvidenceResults.id });
      if (updatedRows.length === 0) return false;

      if (item.targetStatus !== "pending" || input.allowCompleted) {
        await tx
          .update(distillationTargetStates)
          .set({
            status: "pending",
            phase: "selected",
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            nextRetryAt: null,
            attemptCount: 0,
            completedAt: null,
            lastOutcomeKind: "manual_reprocess_rejected",
            lastError: `reprocess_requested:${item.currentReason ?? reason}`.slice(0, 500),
            metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
              reprocessRejectedCandidates: {
                requestedAt: requestedAt.toISOString(),
                reason,
                coverEvidenceResultIds: [item.coverEvidenceResultId],
                mode: "procedure_repair_rule_demotion",
              },
            })}::jsonb` as never,
            updatedAt: requestedAt,
          })
          .where(eq(distillationTargetStates.id, item.targetStateId));
      }
      return true;
    });
    if (!applied) continue;

    item.applied = true;
    updated += 1;
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceReprocessRequested,
      actor: "user",
      payload: {
        targetStateId: item.targetStateId,
        coverEvidenceResultId: item.coverEvidenceResultId,
        oldStatus: item.currentStatus,
        oldStage: item.currentStage,
        oldReason: item.currentReason,
        requestedAt: requestedAt.toISOString(),
      },
    });
  }

  return {
    apply: true,
    matched: items.length,
    updated,
    items,
  };
}
