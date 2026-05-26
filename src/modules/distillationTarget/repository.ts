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

function pipelineCapacityLockKey(distillationVersion: string): string {
  return `distillation_pipeline_capacity:${distillationVersion}`;
}

async function lockPipelineCapacity(
  tx: { execute: (query: SQL) => Promise<unknown> },
  distillationVersion: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${pipelineCapacityLockKey(distillationVersion)}))`,
  );
}

function runningCapacitySql(distillationVersion: string): SQL {
  return sql`(
    select count(*)::int
    from distillation_target_states running_capacity
    where running_capacity.distillation_version = ${distillationVersion}
      and running_capacity.status = 'running'
  ) < ${APP_CONSTANTS.distillationPipelineMaxRunningTargets}`;
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
  recoverOrphanedRunningDistillationTargets,
  releaseRetryablePausedDistillationTargets,
  recoverStaleDistillationTargets,
  markMissingVibeMemoryTargetsSkipped,
  markMissingWikiTargetsSkipped,
  getDistillationTargetSummary,
} from "./repository-maintenance.js";

export {
  finishDistillationTargetState,
  hasRunningFindCandidateTargetState,
  pauseDistillationTargetState,
  releaseDistillationTargetState,
  requeueDistillationTargetState,
  updateDistillationTargetHeartbeat,
  updateDistillationTargetPhase,
  updateDistillationTargetSource,
} from "./repository-state-transitions.js";

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
    await lockPipelineCapacity(tx, distillationVersion);
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where distillation_version = ${distillationVersion}
        and (${targetKind}::text is null or target_kind = ${targetKind})
        and ${runningCapacitySql(distillationVersion)}
        and attempt_count < ${APP_CONSTANTS.distillationTargetMaxAttempts}
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

export async function claimNextCoverEvidenceTargetState(params: {
  distillationVersion?: string;
  targetKind?: DistillationTargetKind;
  worker?: string;
  now?: Date;
}): Promise<DistillationTargetStateRow | null> {
  await ensureRuntimeSettingsLoaded();
  const now = params.now ?? new Date();
  const nowUtc = sql`${now.toISOString()}::timestamptz at time zone 'UTC'`;
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const targetKind = params.targetKind ?? null;
  const lockOwner = params.worker?.trim() || workerId();

  const claimed = await db.transaction(async (tx) => {
    await lockPipelineCapacity(tx, distillationVersion);
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where distillation_version = ${distillationVersion}
        and (${targetKind}::text is null or target_kind = ${targetKind})
        and ${runningCapacitySql(distillationVersion)}
        and attempt_count < ${APP_CONSTANTS.distillationTargetMaxAttempts}
        and (
          status = 'pending'
          or (
            status = 'paused'
            and (
              next_retry_at is null
              or next_retry_at <= ${nowUtc}
            )
          )
        )
        and exists (
          select 1
          from find_candidate_results f
          left join cover_evidence_results c on c.id = f.id
          where f.target_state_id = distillation_target_states.id
            and (
              c.id is null
              or c.status in (
                'reprocess_requested',
                'tool_failed',
                'provider_failed',
                'parse_failed'
              )
            )
        )
      order by
        (
          select min(f.created_at)
          from find_candidate_results f
          left join cover_evidence_results c on c.id = f.id
          where f.target_state_id = distillation_target_states.id
            and (
              c.id is null
              or c.status in (
                'reprocess_requested',
                'tool_failed',
                'provider_failed',
                'parse_failed'
              )
            )
        ) asc,
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
        phase: "covering_evidence",
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
    await lockPipelineCapacity(tx, distillationVersion);
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where id = ${params.id}
        and distillation_version = ${distillationVersion}
        and (${targetKind}::text is null or target_kind = ${targetKind})
        and ${runningCapacitySql(distillationVersion)}
        and attempt_count < ${APP_CONSTANTS.distillationTargetMaxAttempts}
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
    await lockPipelineCapacity(tx, distillationVersion);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`distillation_find_candidate:${distillationVersion}`}))`,
    );
    const selected = await tx.execute(sql`
      select id
      from distillation_target_states
      where id = ${params.id}
        and distillation_version = ${distillationVersion}
        and target_kind = ${params.targetKind}
        and ${runningCapacitySql(distillationVersion)}
        and attempt_count < ${APP_CONSTANTS.distillationTargetMaxAttempts}
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
