import os from "node:os";
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { db } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  priorityGroupForTargetKind,
  sortKeyForTarget,
  type DistillationTargetCandidate,
  type DistillationTargetKind,
  type DistillationTargetPhase,
  type DistillationTargetStatus,
} from "./domain.js";

export const DEFAULT_DISTILLATION_TARGET_VERSION = APP_CONSTANTS.distillationTargetVersion;

export type DistillationTargetStateRow = typeof distillationTargetStates.$inferSelect;

export type TargetLease = {
  targetStateId: string;
  lockedBy: string;
  attemptCount: number;
};

export type DistillationTargetSummary = {
  version: string;
  mode: "wiki_first" | "vibe_memory_fallback" | "idle";
  queued: number;
  pendingWiki: number;
  pendingVibeMemory: number;
  running: number;
  paused: number;
  staleRunning: number;
  failed: number;
  skipped: number;
  completed: number;
  lastCompleted: DistillationTargetStateRow | null;
  lastSkipped: DistillationTargetStateRow | null;
  lastFailed: DistillationTargetStateRow | null;
};

export type RecoveryResult = {
  recoveredToPending: number;
  failed: number;
  skipped: number;
};

function workerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

function nowMinusSeconds(seconds: number, now = new Date()): Date {
  return new Date(now.getTime() - Math.max(1, seconds) * 1000);
}

function staleThresholdMs(staleSeconds: number, now = new Date()): number {
  return nowMinusSeconds(staleSeconds, now).getTime();
}

function rowHeartbeatMs(row: Pick<DistillationTargetStateRow, "heartbeatAt" | "lockedAt">): number {
  const value = row.heartbeatAt ?? row.lockedAt;
  if (!value) return Number.NEGATIVE_INFINITY;
  return value.getTime();
}

function targetIdentity(row: DistillationTargetStateRow): Record<string, unknown> {
  return {
    id: row.id,
    targetKind: row.targetKind,
    targetKey: row.targetKey,
    distillationVersion: row.distillationVersion,
    status: row.status,
  };
}

export function leaseFromTargetState(row: DistillationTargetStateRow): TargetLease {
  return {
    targetStateId: row.id,
    lockedBy: row.lockedBy ?? "",
    attemptCount: row.attemptCount,
  };
}

function targetLeaseWhere(id: string, lease: TargetLease | undefined) {
  const conditions = [eq(distillationTargetStates.id, id)];
  if (lease) {
    conditions.push(
      eq(distillationTargetStates.status, "running"),
      eq(distillationTargetStates.lockedBy, lease.lockedBy),
      eq(distillationTargetStates.attemptCount, lease.attemptCount),
    );
  }
  return and(...conditions);
}

function statusEligibility(now: Date) {
  return or(
    eq(distillationTargetStates.status, "pending"),
    and(
      eq(distillationTargetStates.status, "paused"),
      or(
        isNull(distillationTargetStates.nextRetryAt),
        lte(distillationTargetStates.nextRetryAt, now),
      ),
    ),
  );
}

export async function upsertDistillationTargetState(params: {
  candidate: DistillationTargetCandidate;
  distillationVersion?: string;
  metadata?: Record<string, unknown>;
}): Promise<DistillationTargetStateRow> {
  const now = new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const priorityGroup = priorityGroupForTargetKind(params.candidate.targetKind);
  const sortKey = sortKeyForTarget(params.candidate);
  const metadata = params.metadata ?? {};

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
      sql`case when ${distillationTargetStates.priorityGroup} = 'wiki' then 0 else 1 end`,
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
            and (next_retry_at is null or next_retry_at <= ${now})
          )
        )
      order by
        case when priority_group = 'wiki' then 0 else 1 end asc,
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

export async function releaseRetryablePausedDistillationTargets(
  params: {
    distillationVersion?: string;
    now?: Date;
  } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const rows = await db
    .update(distillationTargetStates)
    .set({
      status: "pending",
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          distillationTargetStates.distillationVersion,
          params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION,
        ),
        eq(distillationTargetStates.status, "paused"),
        lte(distillationTargetStates.nextRetryAt, now),
      ),
    )
    .returning({ id: distillationTargetStates.id });

  return rows.length;
}

export async function recoverStaleDistillationTargets(
  params: {
    distillationVersion?: string;
    staleSeconds?: number;
    maxAttempts?: number;
    now?: Date;
  } = {},
): Promise<RecoveryResult> {
  const now = params.now ?? new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const thresholdMs = staleThresholdMs(
    params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
    now,
  );
  const maxAttempts = params.maxAttempts ?? APP_CONSTANTS.distillationTargetMaxAttempts;
  const runningRows = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        eq(distillationTargetStates.status, "running"),
      ),
    );
  const staleRows = runningRows.filter((row) => rowHeartbeatMs(row) <= thresholdMs);

  let recoveredToPending = 0;
  const failed = 0;
  let skipped = 0;

  for (const stale of staleRows) {
    const nextStatus: DistillationTargetStatus =
      stale.attemptCount >= maxAttempts ? "skipped" : "pending";
    const [row] = await db
      .update(distillationTargetStates)
      .set({
        status: nextStatus,
        phase: nextStatus === "skipped" ? "stored" : "selected",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastOutcomeKind: "stale_running_recovered",
        lastError:
          nextStatus === "skipped"
            ? "stale_running_retry_limit_exceeded"
            : "stale_running_recovered",
        metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
          staleRecovered: true,
          staleRecoveredAt: now.toISOString(),
        })}::jsonb` as never,
        completedAt: nextStatus === "skipped" ? now : null,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, stale.id))
      .returning();
    if (!row) continue;
    if (nextStatus === "skipped") skipped += 1;
    else recoveredToPending += 1;
  }

  if (recoveredToPending > 0 || failed > 0 || skipped > 0) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetRecovered,
      actor: "system",
      payload: {
        distillationVersion,
        recoveredToPending,
        failed,
        skipped,
        staleSeconds: params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
      },
    });
  }

  return { recoveredToPending, failed, skipped };
}

export async function markMissingWikiTargetsSkipped(params: {
  currentTargetKeys: Set<string>;
  rootPath: string;
  distillationVersion?: string;
}): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(
          distillationTargetStates.distillationVersion,
          params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION,
        ),
        eq(distillationTargetStates.targetKind, "wiki_file"),
        inArray(distillationTargetStates.status, ["pending", "running", "paused", "failed"]),
      ),
    );

  let updated = 0;
  for (const row of rows) {
    if (params.currentTargetKeys.has(row.targetKey)) continue;
    const [skipped] = await db
      .update(distillationTargetStates)
      .set({
        status: "skipped",
        phase: "stored",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastOutcomeKind: "missing_source",
        lastError: "wiki_file_missing",
        metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
          missing: true,
          missingDetectedAt: now.toISOString(),
          rootPath: params.rootPath,
        })}::jsonb` as never,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, row.id))
      .returning();
    if (skipped) updated += 1;
  }
  return updated;
}

async function countStaleRunning(
  distillationVersion: string,
  staleSeconds: number,
): Promise<number> {
  const thresholdMs = staleThresholdMs(staleSeconds);
  const rows = await db
    .select({
      heartbeatAt: distillationTargetStates.heartbeatAt,
      lockedAt: distillationTargetStates.lockedAt,
    })
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        eq(distillationTargetStates.status, "running"),
      ),
    );
  return rows.filter((row) => rowHeartbeatMs(row) <= thresholdMs).length;
}

async function lastTargetByStatus(
  status: Extract<DistillationTargetStatus, "completed" | "skipped" | "failed">,
  distillationVersion: string,
): Promise<DistillationTargetStateRow | null> {
  const [row] = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        eq(distillationTargetStates.status, status),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${distillationTargetStates.completedAt}, ${distillationTargetStates.updatedAt})`,
      ),
      desc(distillationTargetStates.id),
    )
    .limit(1);
  return row ?? null;
}

export async function getDistillationTargetSummary(
  params: {
    distillationVersion?: string;
    staleSeconds?: number;
  } = {},
): Promise<DistillationTargetSummary> {
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const rows = await db
    .select({
      targetKind: distillationTargetStates.targetKind,
      status: distillationTargetStates.status,
      value: count(),
    })
    .from(distillationTargetStates)
    .where(eq(distillationTargetStates.distillationVersion, distillationVersion))
    .groupBy(distillationTargetStates.targetKind, distillationTargetStates.status);

  const value = (targetKind: DistillationTargetKind, status: DistillationTargetStatus) =>
    Number(rows.find((row) => row.targetKind === targetKind && row.status === status)?.value ?? 0);
  const statusTotal = (status: DistillationTargetStatus) =>
    Number(
      rows.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.value), 0),
    );

  const pendingWiki = value("wiki_file", "pending") + value("wiki_file", "paused");
  const pendingVibeMemory = value("vibe_memory", "pending") + value("vibe_memory", "paused");
  const queued = pendingWiki + pendingVibeMemory;

  return {
    version: distillationVersion,
    mode: pendingWiki > 0 ? "wiki_first" : pendingVibeMemory > 0 ? "vibe_memory_fallback" : "idle",
    queued,
    pendingWiki,
    pendingVibeMemory,
    running: statusTotal("running"),
    paused: statusTotal("paused"),
    staleRunning: await countStaleRunning(
      distillationVersion,
      params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
    ),
    failed: statusTotal("failed"),
    skipped: statusTotal("skipped"),
    completed: statusTotal("completed"),
    lastCompleted: await lastTargetByStatus("completed", distillationVersion),
    lastSkipped: await lastTargetByStatus("skipped", distillationVersion),
    lastFailed: await lastTargetByStatus("failed", distillationVersion),
  };
}
