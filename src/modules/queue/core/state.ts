import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { db } from "../../../db/index.js";
import type { DistillationQueueName, QueueRetryMode } from "./types.js";
import { queueTableNameByQueue } from "./types.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

type QueueStateRow = {
  id: string;
  status: string;
};

async function updateSqliteQueueState(params: {
  queueName: DistillationQueueName;
  id?: string;
  setSql: string;
  whereSql: string;
  values: unknown[];
}): Promise<QueueStateRow | null> {
  const sqlite = await getSqliteCoreDatabase();
  const tableName = queueTableNameByQueue[params.queueName];
  const result = sqlite.db
    .query<QueueStateRow, unknown[]>(
      `
      update ${tableName}
      set ${params.setSql}
      where ${params.whereSql}
      returning id, status
    `,
    )
    .get(...params.values);
  return result ?? null;
}

export async function pauseQueueJob(params: {
  queueName: DistillationQueueName;
  id: string;
  reason?: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'paused',
        last_error = ?,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status in ('pending', 'running')",
      values: [params.reason ?? "paused from queue control", params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result = await db.execute(sql`
    update ${sql.raw(tableName)}
    set
      status = 'paused',
      last_error = ${params.reason ?? "paused from queue control"},
      locked_by = null,
      locked_at = null,
      heartbeat_at = null,
      updated_at = now()
    where id = ${params.id}
      and status in ('pending', 'running')
    returning id, status
  `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function keepQueueJobWaitingForWorker(params: {
  queueName: DistillationQueueName;
  id: string;
  reason: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        ${params.queueName === "finalizeDistille" ? "" : "next_run_at = null,"}
        last_error = ?,
        last_outcome_kind = 'worker_unavailable',
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status = 'running'",
      values: [params.reason, params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            last_error = ${params.reason},
            last_outcome_kind = 'worker_unavailable',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where id = ${params.id}
            and status = 'running'
          returning id, status
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            next_run_at = null,
            last_error = ${params.reason},
            last_outcome_kind = 'worker_unavailable',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where id = ${params.id}
            and status = 'running'
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function resumeQueueJob(params: {
  queueName: DistillationQueueName;
  id: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        ${params.queueName === "finalizeDistille" ? "" : "next_run_at = null,"}
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        completed_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status in ('paused', 'failed', 'skipped', 'completed')",
      values: [params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = null,
            updated_at = now()
          where id = ${params.id}
            and status in ('paused', 'failed', 'skipped', 'completed')
          returning id, status
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            next_run_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = null,
            updated_at = now()
          where id = ${params.id}
            and status in ('paused', 'failed', 'skipped', 'completed')
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function retryQueueJob(params: {
  queueName: DistillationQueueName;
  id: string;
  mode: QueueRetryMode;
  forceRefreshEvidence: boolean;
  reason?: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        attempt_count = 0,
        ${params.queueName === "finalizeDistille" ? "" : "next_run_at = null,"}
        completed_at = null,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status <> 'running'",
      values: [params.reason ?? null, params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "findingCandidate"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            attempt_count = 0,
            next_run_at = null,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            payload = coalesce(payload, '{}'::jsonb) ||
              jsonb_build_object(
                'forceRefreshEvidence', ${params.forceRefreshEvidence}::boolean,
                'retryMode', ${params.mode}::text,
                'retryReason', ${params.reason ?? null}::text,
                'retryRequestedAt', now()::text
              ),
            updated_at = now()
          where id = ${params.id}
            and status <> 'running'
          returning id, status
        `)
      : params.queueName === "finalizeDistille"
        ? await db.execute(sql`
            update ${sql.raw(tableName)}
            set
              status = 'pending',
              attempt_count = 0,
              completed_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              provider_policy = case
                when ${params.mode}::text = 'cloud_api' then 'cloud_api'
                else provider_policy
              end,
              metadata = coalesce(metadata, '{}'::jsonb) ||
                jsonb_build_object(
                  'forceRefreshEvidence', ${params.forceRefreshEvidence}::boolean,
                  'retryMode', ${params.mode}::text,
                  'retryReason', ${params.reason ?? null}::text,
                  'retryRequestedAt', now()::text
                ),
              updated_at = now()
            where id = ${params.id}
              and status <> 'running'
            returning id, status
          `)
        : params.queueName === "deadZoneMergeReview" ||
            params.queueName === "mergeActivationFinalize"
          ? await db.execute(sql`
            update ${sql.raw(tableName)}
            set
              status = 'pending',
              attempt_count = 0,
              next_run_at = null,
              completed_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              last_error = null,
              payload = coalesce(payload, '{}'::jsonb) ||
                jsonb_build_object(
                  'retryMode', ${params.mode}::text,
                  'retryReason', ${params.reason ?? null}::text,
                  'retryRequestedAt', now()::text
                ),
              updated_at = now()
            where id = ${params.id}
              and status <> 'running'
            returning id, status
          `)
          : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            attempt_count = 0,
            next_run_at = null,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            provider_policy = case
              when ${params.mode}::text = 'cloud_api' then 'cloud_api'
              else provider_policy
            end,
            payload = coalesce(payload, '{}'::jsonb) ||
              jsonb_build_object(
                'forceRefreshEvidence', ${params.forceRefreshEvidence}::boolean,
                'retryMode', ${params.mode}::text,
                'retryReason', ${params.reason ?? null}::text,
                'retryRequestedAt', now()::text
              ),
            updated_at = now()
          where id = ${params.id}
            and status <> 'running'
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function pauseRunningQueueJobs(params: {
  queueName: DistillationQueueName;
  reason?: string;
}): Promise<number> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const tableName = queueTableNameByQueue[params.queueName];
    const result = sqlite.db
      .query(
        `
        update ${tableName}
        set
          status = 'paused',
          last_error = ?,
          ${params.queueName === "finalizeDistille" ? "" : "next_run_at = CURRENT_TIMESTAMP,"}
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          updated_at = CURRENT_TIMESTAMP
        where status = 'running'
      `,
      )
      .run(params.reason ?? "queue paused from queue control");
    return Number(result.changes ?? 0);
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'paused',
            last_error = ${params.reason ?? "queue paused from queue control"},
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where status = 'running'
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'paused',
            last_error = ${params.reason ?? "queue paused from queue control"},
            next_run_at = now(),
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where status = 'running'
        `);
  return result.rowCount ?? 0;
}
