import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { db } from "../../db/index.js";
import { distillationTargetStates, findCandidateResults } from "../../db/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveDistillationTargetPriorityOrder,
} from "../settings/settings.service.js";
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

const priorityGroupByTargetKind = {
  knowledge_candidate: "knowledge_candidate",
  web_ingest: "web_ingest",
  wiki_file: "wiki",
  vibe_memory: "vibe_memory",
} as const satisfies Record<DistillationTargetKind, DistillationTargetPriorityGroup>;

function priorityGroupsFromRuntimeSettings(): DistillationTargetPriorityGroup[] {
  const order = resolveDistillationTargetPriorityOrder();
  const groups: DistillationTargetPriorityGroup[] = [];
  for (const kind of order) {
    const group = priorityGroupByTargetKind[kind];
    if (!groups.includes(group)) groups.push(group);
  }
  return groups;
}

function buildPriorityRankCase(order: DistillationTargetPriorityGroup[]) {
  const clauses = order.map(
    (group, index) => sql`when ${distillationTargetStates.priorityGroup} = ${group} then ${index}`,
  );
  return sql`case ${sql.join(clauses, sql` `)} else ${order.length} end`;
}

function buildPriorityRankCaseRaw(order: DistillationTargetPriorityGroup[]): string {
  const clauses = order
    .map((group, index) => `when priority_group = '${group}' then ${index}`)
    .join(" ");
  return `case ${clauses} else ${order.length} end`;
}

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
  markMissingVibeMemoryTargetsSkipped,
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
  const metadata = redactSecretRecord(params.metadata ?? {});
  const candidate: DistillationTargetCandidate = {
    ...params.candidate,
    targetKey: redactSecrets(params.candidate.targetKey),
    sourceUri: redactSecrets(params.candidate.sourceUri),
    sortKey: params.candidate.sortKey ? redactSecrets(params.candidate.sortKey) : undefined,
  };
  const priorityGroup =
    params.priorityGroup ??
    (candidate.targetKind === "knowledge_candidate"
      ? resolveKnowledgeCandidatePriorityGroup({
          sourceUri: candidate.sourceUri,
          metadata,
        })
      : priorityGroupForTargetKind(candidate.targetKind));
  const sortKey = sortKeyForTarget(candidate);

  const [state] = await db
    .insert(distillationTargetStates)
    .values({
      targetKind: candidate.targetKind,
      targetKey: candidate.targetKey,
      sourceUri: candidate.sourceUri,
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
        sourceUri: candidate.sourceUri,
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
  await ensureRuntimeSettingsLoaded();
  const now = params.now ?? new Date();
  const priorityOrder = priorityGroupsFromRuntimeSettings();
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
      buildPriorityRankCase(priorityOrder),
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
    requireCandidateResultsForSourceTargets?: boolean;
  } = {},
): Promise<DistillationTargetStateRow | null> {
  await ensureRuntimeSettingsLoaded();
  const now = params.now ?? new Date();
  const priorityOrder = priorityGroupsFromRuntimeSettings();
  const priorityRankCase = buildPriorityRankCaseRaw(priorityOrder);
  const nowUtc = sql`${now.toISOString()}::timestamptz at time zone 'UTC'`;
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const targetKind = params.targetKind ?? null;
  const lockOwner = params.worker?.trim() || workerId();
  const requireCandidateResultsForSourceTargets =
    params.requireCandidateResultsForSourceTargets ?? false;

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
        and (
          ${requireCandidateResultsForSourceTargets} = false
          or target_kind = 'knowledge_candidate'
          or exists (
            select 1
            from find_candidate_results
            where target_state_id = distillation_target_states.id
          )
        )
      order by
        ${sql.raw(priorityRankCase)} asc,
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

export async function findNextFindCandidateTargetState(params: {
  distillationVersion?: string;
  targetKinds: DistillationTargetKind[];
  now?: Date;
}): Promise<DistillationTargetStateRow | null> {
  await ensureRuntimeSettingsLoaded();
  if (params.targetKinds.length === 0) return null;
  const now = params.now ?? new Date();
  const priorityOrder = priorityGroupsFromRuntimeSettings();
  const priorityRankCase = buildPriorityRankCase(priorityOrder);
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;

  const rows = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        inArray(distillationTargetStates.targetKind, params.targetKinds),
        statusEligibility(now),
        sql`not exists (
          select 1
          from ${findCandidateResults}
          where ${findCandidateResults.targetStateId} = ${distillationTargetStates.id}
        )`,
        sql`not exists (
          select 1
          from ${distillationTargetStates} running_target
          where running_target.distillation_version = ${distillationVersion}
            and running_target.status = 'running'
            and running_target.phase = 'finding_candidate'
        )`,
      ),
    )
    .orderBy(
      priorityRankCase,
      asc(distillationTargetStates.sortKey),
      asc(distillationTargetStates.createdAt),
      asc(distillationTargetStates.id),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function claimFindCandidateTargetStateById(params: {
  id: string;
  distillationVersion?: string;
  targetKind: DistillationTargetKind;
  worker?: string;
  now?: Date;
}): Promise<DistillationTargetStateRow | null> {
  const now = params.now ?? new Date();
  const nowUtc = sql`${now.toISOString()}::timestamptz at time zone 'UTC'`;
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const lockOwner = params.worker?.trim() || workerId();

  const claimed = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`distillation_find_candidate:${distillationVersion}`}))`,
    );
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where id = ${params.id}
        and distillation_version = ${distillationVersion}
        and target_kind = ${params.targetKind}
        and (
          status = 'pending'
          or (
            status = 'paused'
            and (next_retry_at is null or next_retry_at <= ${nowUtc})
          )
        )
        and not exists (
          select 1
          from find_candidate_results
          where target_state_id = distillation_target_states.id
        )
        and not exists (
          select 1
          from distillation_target_states running_target
          where running_target.distillation_version = ${distillationVersion}
            and running_target.status = 'running'
            and running_target.phase = 'finding_candidate'
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
        phase: "finding_candidate",
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
