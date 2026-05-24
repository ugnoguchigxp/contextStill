import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { db } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  type DistillationTargetCandidate,
  type DistillationTargetKind,
  type DistillationTargetPhase,
  type DistillationTargetPriorityGroup,
  type DistillationTargetStatus,
  priorityGroupForTargetKind,
  sortKeyForTarget,
} from "./domain.js";
import { resolveKnowledgeCandidatePriorityGroup } from "./priority-group.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
  type TargetLease,
  statusEligibility,
  targetIdentity,
  targetLeaseWhere,
  workerId,
} from "./repository-helpers.js";

// Re-export constants, types and helpers from repository-helpers.js
export {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
  type TargetLease,
  leaseFromTargetState,
} from "./repository-helpers.js";

// Re-export types and functions from repository-maintenance.js
export {
  type DistillationTargetSummary,
  type RecoveryResult,
  releaseRetryablePausedDistillationTargets,
  recoverStaleDistillationTargets,
  markMissingWikiTargetsSkipped,
  getDistillationTargetSummary,
} from "./repository-maintenance.js";

export async function upsertDistillationTargetState(params: {
  candidate: DistillationTargetCandidate;
  distillationVersion?: string;
  metadata?: Record<string, unknown>;
  priorityGroup?: DistillationTargetPriorityGroup;
}): Promise<DistillationTargetStateRow> {
  const now = new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const metadata = params.metadata ?? {};
  const priorityGroup =
    params.priorityGroup ??
    (params.candidate.targetKind === "knowledge_candidate"
      ? resolveKnowledgeCandidatePriorityGroup({
          sourceUri: params.candidate.sourceUri,
          metadata,
        })
      : priorityGroupForTargetKind(params.candidate.targetKind));
  const sortKey = sortKeyForTarget(params.candidate);

  const [state] = await db
    .insert(distillationTargetStates)
    .values({
      targetKind: params.candidate.targetKind,
      targetKey: params.candidate.targetKey,
      sourceUri: params.candidate.sourceUri,
      distillationVersion,
      status: "pending",
      phase: "selected",
      priorityGroup,
      sortKey,
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        distillationTargetStates.targetKind,
        distillationTargetStates.targetKey,
        distillationTargetStates.distillationVersion,
      ],
      set: {
        sourceUri: params.candidate.sourceUri,
        priorityGroup,
        sortKey,
        metadata:
          sql`${distillationTargetStates.metadata} || ${JSON.stringify(metadata)}::jsonb` as never,
        updatedAt: now,
      },
    })
    .returning();

  if (!state) throw new Error("failed to upsert distillation target state");
  return state;
}

export async function getDistillationTargetStateById(
  id: string,
): Promise<DistillationTargetStateRow | null> {
  const [row] = await db
    .select()
    .from(distillationTargetStates)
    .where(eq(distillationTargetStates.id, id))
    .limit(1);
  return row ?? null;
}

export async function findNextSelectableDistillationTargetState(
  params: {
    distillationVersion?: string;
    targetKind?: DistillationTargetKind;
    now?: Date;
  } = {},
): Promise<DistillationTargetStateRow | null> {
  const now = params.now ?? new Date();
  const conditions = [
    eq(
      distillationTargetStates.distillationVersion,
      params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION,
    ),
    statusEligibility(now),
  ];
  if (params.targetKind) {
    conditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }

  const [row] = await db
    .select()
    .from(distillationTargetStates)
    .where(and(...conditions))
    .orderBy(
      sql`case
        when ${distillationTargetStates.priorityGroup} = 'knowledge_candidate' then 0
        when ${distillationTargetStates.priorityGroup} = 'wiki' then 1
        else 2
      end`,
      asc(distillationTargetStates.sortKey),
      asc(distillationTargetStates.createdAt),
      asc(distillationTargetStates.id),
    )
    .limit(1);

  return row ?? null;
}

export async function listDistillationTargetStatesForCandidates(params: {
  candidates: DistillationTargetCandidate[];
  distillationVersion?: string;
}): Promise<DistillationTargetStateRow[]> {
  if (params.candidates.length === 0) return [];
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const targetKeys = [...new Set(params.candidates.map((candidate) => candidate.targetKey))];
  const targetKinds = [...new Set(params.candidates.map((candidate) => candidate.targetKind))];

  return db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        inArray(distillationTargetStates.targetKind, targetKinds),
        inArray(distillationTargetStates.targetKey, targetKeys),
      ),
    );
}

export async function claimNextDistillationTargetState(
  params: {
    distillationVersion?: string;
    targetKind?: DistillationTargetKind;
    worker?: string;
    now?: Date;
  } = {},
): Promise<DistillationTargetStateRow | null> {
  const now = params.now ?? new Date();
  const nowUtc = sql`${now.toISOString()}::timestamptz at time zone 'UTC'`;
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const targetKind = params.targetKind ?? null;
  const lockOwner = params.worker?.trim() || workerId();

  const claimed = await db.transaction(async (tx) => {
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where distillation_version = ${distillationVersion}
        and (${targetKind}::text is null or target_kind = ${targetKind})
        and (
          status = 'pending'
          or (
            status = 'paused'
            and (next_retry_at is null or next_retry_at <= ${nowUtc})
          )
        )
      order by
        case
          when priority_group = 'knowledge_candidate' then 0
          when priority_group = 'wiki' then 1
          else 2
        end asc,
        sort_key asc,
        created_at asc,
        id asc
      for update skip locked
      limit 1
    `);
    const id = (selected.rows as Array<{ id?: string }>)[0]?.id;
    if (!id) return null;

    const [row] = await tx
      .update(distillationTargetStates)
      .set({
        status: "running",
        phase: "selected",
        lockedBy: lockOwner,
        lockedAt: now,
        heartbeatAt: now,
        nextRetryAt: null,
        attemptCount: sql`${distillationTargetStates.attemptCount} + 1` as never,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, id))
      .returning();
    return row ?? null;
  });

  if (claimed) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetClaimed,
      actor: "system",
      payload: targetIdentity(claimed),
    });
  }

  return claimed;
}

export async function claimDistillationTargetStateById(params: {
  id: string;
  distillationVersion?: string;
  targetKind?: DistillationTargetKind;
  worker?: string;
  now?: Date;
}): Promise<DistillationTargetStateRow | null> {
  const now = params.now ?? new Date();
  const nowUtc = sql`${now.toISOString()}::timestamptz at time zone 'UTC'`;
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const targetKind = params.targetKind ?? null;
  const lockOwner = params.worker?.trim() || workerId();

  const claimed = await db.transaction(async (tx) => {
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where id = ${params.id}
        and distillation_version = ${distillationVersion}
        and (${targetKind}::text is null or target_kind = ${targetKind})
        and (
          status = 'pending'
          or (
            status = 'paused'
            and (next_retry_at is null or next_retry_at <= ${nowUtc})
          )
        )
      for update skip locked
      limit 1
    `);
    const id = (selected.rows as Array<{ id?: string }>)[0]?.id;
    if (!id) return null;

    const [row] = await tx
      .update(distillationTargetStates)
      .set({
        status: "running",
        phase: "selected",
        lockedBy: lockOwner,
        lockedAt: now,
        heartbeatAt: now,
        nextRetryAt: null,
        attemptCount: sql`${distillationTargetStates.attemptCount} + 1` as never,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, id))
      .returning();
    return row ?? null;
  });

  if (claimed) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetClaimed,
      actor: "system",
      payload: targetIdentity(claimed),
    });
  }

  return claimed;
}

export async function updateDistillationTargetHeartbeat(
  id: string,
  lease?: TargetLease,
): Promise<DistillationTargetStateRow | null> {
  const now = new Date();
  const [row] = await db
    .update(distillationTargetStates)
    .set({
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(
      lease
        ? targetLeaseWhere(id, lease)
        : and(eq(distillationTargetStates.id, id), eq(distillationTargetStates.status, "running")),
    )
    .returning();

  if (row) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetHeartbeat,
      actor: "system",
      payload: targetIdentity(row),
    });
  }

  return row ?? null;
}

export async function updateDistillationTargetPhase(params: {
  id: string;
  phase: DistillationTargetPhase;
  lease?: TargetLease;
}): Promise<DistillationTargetStateRow | null> {
  const [row] = await db
    .update(distillationTargetStates)
    .set({
      phase: params.phase,
      updatedAt: new Date(),
    })
    .where(targetLeaseWhere(params.id, params.lease))
    .returning();
  return row ?? null;
}

export async function finishDistillationTargetState(params: {
  id: string;
  status: Extract<DistillationTargetStatus, "completed" | "skipped" | "failed">;
  outcomeKind?: string | null;
  error?: string | null;
  candidateCount?: number;
  knowledgeIds?: string[];
  metadata?: Record<string, unknown>;
  lease?: TargetLease;
}): Promise<DistillationTargetStateRow | null> {
  const now = new Date();
  const [row] = await db
    .update(distillationTargetStates)
    .set({
      status: params.status,
      phase: "stored",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      nextRetryAt: null,
      lastOutcomeKind: params.outcomeKind ?? null,
      lastError: params.error ?? null,
      candidateCount: params.candidateCount,
      knowledgeIds: params.knowledgeIds,
      metadata: params.metadata
        ? (sql`${distillationTargetStates.metadata} || ${JSON.stringify(params.metadata)}::jsonb` as never)
        : undefined,
      completedAt: now,
      updatedAt: now,
    })
    .where(targetLeaseWhere(params.id, params.lease))
    .returning();

  if (row) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetStatusChanged,
      actor: "system",
      payload: {
        ...targetIdentity(row),
        outcomeKind: params.outcomeKind ?? null,
      },
    });
  }

  return row ?? null;
}

export async function pauseDistillationTargetState(params: {
  id: string;
  reason: string;
  retryDelaySeconds?: number;
  metadata?: Record<string, unknown>;
  lease?: TargetLease;
}): Promise<DistillationTargetStateRow | null> {
  const now = new Date();
  const retryDelaySeconds =
    params.retryDelaySeconds ?? APP_CONSTANTS.distillationTargetRetryDelaySeconds;
  const [row] = await db
    .update(distillationTargetStates)
    .set({
      status: "paused",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      nextRetryAt: new Date(now.getTime() + retryDelaySeconds * 1000),
      lastOutcomeKind: "paused",
      lastError: params.reason,
      metadata: params.metadata
        ? (sql`${distillationTargetStates.metadata} || ${JSON.stringify(params.metadata)}::jsonb` as never)
        : undefined,
      updatedAt: now,
    })
    .where(targetLeaseWhere(params.id, params.lease))
    .returning();

  if (row) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetStatusChanged,
      actor: "system",
      payload: { ...targetIdentity(row), reason: params.reason },
    });
  }

  return row ?? null;
}

export async function requeueDistillationTargetState(params: {
  id: string;
  reason?: string;
  allowCompleted?: boolean;
}): Promise<DistillationTargetStateRow | null> {
  const conditions = [eq(distillationTargetStates.id, params.id)];
  if (!params.allowCompleted) {
    conditions.push(sql`${distillationTargetStates.status} <> 'completed'` as never);
  }

  const [row] = await db
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
      lastOutcomeKind: "manual_requeue",
      lastError: params.reason ?? null,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();

  if (row) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetStatusChanged,
      actor: "user",
      payload: { ...targetIdentity(row), reason: params.reason ?? null },
    });
  }

  return row ?? null;
}
