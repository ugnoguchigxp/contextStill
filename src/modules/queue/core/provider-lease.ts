import { groupedConfig } from "../../../config.js";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import type {
  RuntimeProviderPool,
  RuntimeProviderPoolTarget,
} from "../../settings/settings.types.js";
import { isQueuePaused } from "./control.js";
import type { DistillationQueueName } from "./types.js";
import { queueTableNameByQueue } from "./types.js";

export type ProviderLease = {
  id: string;
  poolId: string;
  targetId: string;
  queueName: DistillationQueueName;
  queueJobId: string;
  workerId: string;
};

export type QueueJobWithProviderLease = {
  queueName: DistillationQueueName;
  id: string;
  providerLease: ProviderLease;
};

type RunnableCandidate = {
  queueName: DistillationQueueName;
  tableName: string;
  id: string;
  queueOrder: number;
  effectivePriority: number;
  priority: number;
  createdAtMs: number;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function targetId(target: RuntimeProviderPoolTarget): string {
  if (target.provider === "local-llm") return target.localLlmModelId;
  if (target.provider === "azure-openai") return String(target.deploymentSlot);
  return target.targetId;
}

function activePoolCapacity(pool: RuntimeProviderPool): number {
  return Math.max(1, Math.min(pool.maxConcurrent, pool.targets.length));
}

function staleCutoffIso(pool: RuntimeProviderPool): string {
  const seconds = Math.max(30, Math.floor(pool.staleLeaseSeconds));
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function recoverStaleQueueJobsSql(queueName: DistillationQueueName, tableName: string): string {
  return `
    update ${tableName}
    set
      status = 'paused',
      ${queueName === "finalizeDistille" ? "" : "next_run_at = CURRENT_TIMESTAMP,"}
      locked_by = null,
      locked_at = null,
      heartbeat_at = null,
      last_error = coalesce(last_error, 'stale_running_recovered'),
      last_outcome_kind = 'stale_recovered',
      updated_at = CURRENT_TIMESTAMP
    where status = 'running'
      and coalesce(heartbeat_at, locked_at, updated_at) < ?
  `;
}

function runnableSql(queueName: DistillationQueueName, tableName: string): string {
  const nextRunCondition =
    queueName === "finalizeDistille"
      ? ""
      : "and (next_run_at is null or next_run_at <= CURRENT_TIMESTAMP)";
  return `
    select id, priority, created_at
    from ${tableName}
    where status in ('pending', 'paused')
      ${nextRunCondition}
    order by priority desc, created_at asc, id asc
    limit 20
  `;
}

function sortCandidates(a: RunnableCandidate, b: RunnableCandidate): number {
  if (a.effectivePriority !== b.effectivePriority) return a.effectivePriority - b.effectivePriority;
  if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id.localeCompare(b.id);
}

function rowCreatedAtMs(value: unknown): number {
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export async function recoverStaleProviderLeases(pool: RuntimeProviderPool): Promise<number> {
  if (!isSqliteBackend()) return 0;
  const sqlite = await getSqliteCoreDatabase();
  const result = sqlite.db
    .query(
      `
      update llm_provider_leases
      set
        status = 'stale_recovered',
        released_at = CURRENT_TIMESTAMP,
        release_reason = 'stale_heartbeat',
        updated_at = CURRENT_TIMESTAMP
      where pool_id = ?
        and status = 'active'
        and coalesce(heartbeat_at, locked_at, updated_at) < ?
    `,
    )
    .run(pool.id, staleCutoffIso(pool));
  return Number(result.changes ?? 0);
}

export async function heartbeatProviderLease(leaseId: string): Promise<void> {
  if (!isSqliteBackend()) return;
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `
      update llm_provider_leases
      set heartbeat_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      where id = ?
        and status = 'active'
    `,
    )
    .run(leaseId);
}

export async function releaseProviderLease(
  leaseId: string,
  reason = "worker_finished",
): Promise<void> {
  if (!isSqliteBackend()) return;
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `
      update llm_provider_leases
      set status = 'released',
          released_at = CURRENT_TIMESTAMP,
          release_reason = ?,
          updated_at = CURRENT_TIMESTAMP
      where id = ?
        and status = 'active'
    `,
    )
    .run(reason, leaseId);
}

export async function countAvailableProviderPoolSlots(pool: RuntimeProviderPool): Promise<number> {
  if (!isSqliteBackend() || !pool.enabled) return 0;
  await recoverStaleProviderLeases(pool);
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<{ count: number }, [string]>(
      "select count(*) as count from llm_provider_leases where pool_id = ? and status = 'active'",
    )
    .get(pool.id);
  return Math.max(0, activePoolCapacity(pool) - Number(row?.count ?? 0));
}

export async function claimNextJobWithProviderLease(params: {
  pool: RuntimeProviderPool;
  priorityQueues: DistillationQueueName[];
  workerId: string;
}): Promise<QueueJobWithProviderLease | null> {
  if (!params.pool.enabled || params.pool.targets.length === 0) return null;
  if (!isSqliteBackend()) return null;

  const sqlite = await getSqliteCoreDatabase();
  const queueStaleSeconds = Math.max(
    30,
    Math.min(120, Math.floor(groupedConfig.distillation.lockTtlSeconds)),
  );
  const queueStaleCutoff = new Date(Date.now() - queueStaleSeconds * 1000).toISOString();
  const nowMs = Date.now();
  const agingSeconds = Math.max(60, Math.floor(params.pool.lowPriorityAgingSeconds));
  const pausedQueues = new Set<DistillationQueueName>();
  await Promise.all(
    params.priorityQueues.map(async (queueName) => {
      if (await isQueuePaused(queueName)) pausedQueues.add(queueName);
    }),
  );

  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    sqlite.db
      .query(
        `
        update llm_provider_leases
        set
          status = 'stale_recovered',
          released_at = CURRENT_TIMESTAMP,
          release_reason = 'stale_heartbeat',
          updated_at = CURRENT_TIMESTAMP
        where pool_id = ?
          and status = 'active'
          and coalesce(heartbeat_at, locked_at, updated_at) < ?
      `,
      )
      .run(params.pool.id, staleCutoffIso(params.pool));

    const activeLeaseCount =
      sqlite.db
        .query<{ count: number }, [string]>(
          "select count(*) as count from llm_provider_leases where pool_id = ? and status = 'active'",
        )
        .get(params.pool.id)?.count ?? 0;
    if (Number(activeLeaseCount) >= activePoolCapacity(params.pool)) {
      sqlite.db.query("COMMIT").run();
      return null;
    }

    const activeTargets = new Set(
      (
        sqlite.db
          .query<{ target_id: string }, [string]>(
            "select target_id from llm_provider_leases where pool_id = ? and status = 'active'",
          )
          .all(params.pool.id) ?? []
      ).map((row) => row.target_id),
    );
    const selectedTarget = params.pool.targets.find(
      (target) => !activeTargets.has(targetId(target)),
    );
    if (!selectedTarget) {
      sqlite.db.query("COMMIT").run();
      return null;
    }
    const selectedTargetId = targetId(selectedTarget);

    const candidates: RunnableCandidate[] = [];
    for (const [queueOrder, queueName] of params.priorityQueues.entries()) {
      if (pausedQueues.has(queueName)) continue;
      const tableName = queueTableNameByQueue[queueName];
      sqlite.db.query(recoverStaleQueueJobsSql(queueName, tableName)).run(queueStaleCutoff);
      const running = sqlite.db
        .query<{ id: string }, []>(`select id from ${tableName} where status = 'running' limit 1`)
        .get();
      if (running) continue;
      const rows = sqlite.db
        .query<{ id: string; priority: number; created_at: string }, []>(
          runnableSql(queueName, tableName),
        )
        .all();
      for (const row of rows) {
        const createdAtMs = rowCreatedAtMs(row.created_at);
        const waitingSeconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
        candidates.push({
          queueName,
          tableName,
          id: row.id,
          queueOrder,
          effectivePriority: queueOrder - Math.floor(waitingSeconds / agingSeconds),
          priority: Number(row.priority ?? 0),
          createdAtMs,
        });
      }
    }

    const picked = candidates.sort(sortCandidates)[0];
    if (!picked) {
      sqlite.db.query("COMMIT").run();
      return null;
    }

    sqlite.db
      .query(
        `
        update ${picked.tableName}
        set
          status = 'running',
          locked_by = ?,
          locked_at = CURRENT_TIMESTAMP,
          heartbeat_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        where id = ?
          and status in ('pending', 'paused')
      `,
      )
      .run(params.workerId, picked.id);

    const leaseId = crypto.randomUUID();
    sqlite.db
      .query(
        `
        insert into llm_provider_leases (
          id, pool_id, target_id, queue_name, queue_job_id, worker_id,
          status, locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
        ) values (
          ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
          datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `,
      )
      .run(
        leaseId,
        params.pool.id,
        selectedTargetId,
        picked.queueName,
        picked.id,
        params.workerId,
        Math.max(30, Math.floor(params.pool.staleLeaseSeconds)),
      );

    sqlite.db.query("COMMIT").run();
    return {
      queueName: picked.queueName,
      id: picked.id,
      providerLease: {
        id: leaseId,
        poolId: params.pool.id,
        targetId: selectedTargetId,
        queueName: picked.queueName,
        queueJobId: picked.id,
        workerId: params.workerId,
      },
    };
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}
