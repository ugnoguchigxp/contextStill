import { type SQL, and, eq, sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { db } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationTargetPhase, DistillationTargetStatus } from "./domain.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
  type TargetLease,
  targetIdentity,
  targetLeaseWhere,
} from "./repository-helpers.js";

export async function hasRunningFindCandidateTargetState(params: {
  distillationVersion?: string;
  excludeTargetStateId?: string;
}): Promise<boolean> {
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const conditions: SQL[] = [
    eq(distillationTargetStates.distillationVersion, distillationVersion),
    eq(distillationTargetStates.status, "running"),
    eq(distillationTargetStates.phase, "finding_candidate"),
  ];
  if (params.excludeTargetStateId) {
    conditions.push(sql`${distillationTargetStates.id} <> ${params.excludeTargetStateId}`);
  }

  const [row] = await db
    .select({ id: distillationTargetStates.id })
    .from(distillationTargetStates)
    .where(and(...conditions))
    .limit(1);
  return Boolean(row);
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
  distillationVersion?: string;
  requireNoOtherRunningFindCandidate?: boolean;
}): Promise<DistillationTargetStateRow | null> {
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const findCandidateExclusive =
    params.requireNoOtherRunningFindCandidate && params.phase === "finding_candidate";
  if (findCandidateExclusive) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`distillation_find_candidate:${distillationVersion}`}))`,
      );
      const [row] = await tx
        .update(distillationTargetStates)
        .set({
          phase: params.phase,
          updatedAt: new Date(),
        })
        .where(
          and(
            targetLeaseWhere(params.id, params.lease),
            sql`not exists (
              select 1
              from ${distillationTargetStates} running_target
              where running_target.distillation_version = ${distillationVersion}
                and running_target.status = 'running'
                and running_target.phase = 'finding_candidate'
                and running_target.id <> ${params.id}
            )`,
          ),
        )
        .returning();
      return row ?? null;
    });
  }

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

export async function updateDistillationTargetSource(params: {
  id: string;
  sourceUri: string;
  metadata?: Record<string, unknown>;
  lease?: TargetLease;
}): Promise<DistillationTargetStateRow | null> {
  const sourceUri = redactSecrets(params.sourceUri);
  const metadata = params.metadata ? redactSecretRecord(params.metadata) : undefined;
  const [row] = await db
    .update(distillationTargetStates)
    .set({
      sourceUri,
      metadata: metadata
        ? (sql`${distillationTargetStates.metadata} || ${JSON.stringify(metadata)}::jsonb` as never)
        : undefined,
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
  const error = params.error ? redactSecrets(params.error) : params.error;
  const metadata = params.metadata ? redactSecretRecord(params.metadata) : undefined;
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
      lastError: error ?? null,
      candidateCount: params.candidateCount,
      knowledgeIds: params.knowledgeIds,
      metadata: metadata
        ? (sql`${distillationTargetStates.metadata} || ${JSON.stringify(metadata)}::jsonb` as never)
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

export async function releaseDistillationTargetState(params: {
  id: string;
  phase: DistillationTargetPhase;
  outcomeKind?: string | null;
  candidateCount?: number;
  metadata?: Record<string, unknown>;
  lease?: TargetLease;
}): Promise<DistillationTargetStateRow | null> {
  const now = new Date();
  const metadata = params.metadata ? redactSecretRecord(params.metadata) : undefined;
  const [row] = await db
    .update(distillationTargetStates)
    .set({
      status: "pending",
      phase: params.phase,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      nextRetryAt: null,
      lastOutcomeKind: params.outcomeKind ?? null,
      lastError: null,
      candidateCount: params.candidateCount,
      metadata: metadata
        ? (sql`${distillationTargetStates.metadata} || ${JSON.stringify(metadata)}::jsonb` as never)
        : undefined,
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
  const reason = redactSecrets(params.reason);
  const metadata = params.metadata ? redactSecretRecord(params.metadata) : undefined;
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
      lastError: reason,
      metadata: metadata
        ? (sql`${distillationTargetStates.metadata} || ${JSON.stringify(metadata)}::jsonb` as never)
        : undefined,
      updatedAt: now,
    })
    .where(targetLeaseWhere(params.id, params.lease))
    .returning();

  if (row) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetStatusChanged,
      actor: "system",
      payload: { ...targetIdentity(row), reason },
    });
  }

  return row ?? null;
}

export async function requeueDistillationTargetState(params: {
  id: string;
  reason?: string;
  allowCompleted?: boolean;
  resetAttemptCount?: boolean;
  maxAttempts?: number;
}): Promise<DistillationTargetStateRow | null> {
  const conditions = [eq(distillationTargetStates.id, params.id)];
  if (!params.allowCompleted) {
    conditions.push(sql`${distillationTargetStates.status} <> 'completed'` as never);
  }
  if (typeof params.maxAttempts === "number") {
    conditions.push(
      sql`${distillationTargetStates.attemptCount} < ${Math.max(1, params.maxAttempts)}` as never,
    );
  }
  const resetAttemptCount = params.resetAttemptCount ?? true;

  const [row] = await db
    .update(distillationTargetStates)
    .set({
      status: "pending",
      phase: "selected",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      nextRetryAt: null,
      attemptCount: resetAttemptCount ? 0 : undefined,
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
