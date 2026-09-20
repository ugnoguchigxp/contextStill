import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};

export type RecoverySqliteDatabase = {
  query(sql: string): SqliteStatement;
  exec(sql: string): void;
};

type RecoveryQueueName = "findingCandidate" | "episodeDistiller";

type RecoveryCandidate = {
  queue_name: RecoveryQueueName;
  queue_table: "finding_candidate_queue" | "episode_distiller_queue";
  id: string;
  attempt_count: number;
  updated_at: string;
  last_error: string;
};

type RecoveryEventRow = {
  queue_name: RecoveryQueueName;
  queue_job_id: string;
  created_at: string;
};

type QueueStateRow = {
  status: string;
  last_outcome_kind: string | null;
  count: number;
};

type EventCountRow = {
  event_type: string;
  count: number;
};

type LeaseCountRow = {
  target_id: string;
  status: string;
  release_reason: string | null;
  count: number;
};

type FailureCountRow = {
  queue_name: string;
  status: string;
  reason: string;
  count: number;
};

export type LarmRecoveryResult = {
  mode: "dry-run" | "write";
  batchId: string;
  requestedLimit: number;
  matched: number;
  hasMore: boolean;
  requeued: number;
  skipped: number;
  byQueue: Record<RecoveryQueueName, number>;
  startedAt: string;
  finishedAt: string;
};

export type LarmRecoveryTrace = {
  traceVersion: "datetime-normalized-v1";
  batchId: string;
  requeued: number;
  firstRequeuedAt: string | null;
  lastRequeuedAt: string | null;
  states: Array<{ queueName: string; status: string; outcome: string | null; count: number }>;
  events: Array<{ eventType: string; count: number }>;
  failures: Array<{ queueName: string; status: string; reason: string; count: number }>;
  leases: Array<{
    targetId: string;
    status: string;
    releaseReason: string | null;
    count: number;
  }>;
  tracedAt: string;
};

export const LARM_RECOVERY_KIND = "larm_tcp_unreachable_recovery_v1";
export const LARM_ENDPOINT_NEEDLE = "192.168.0.130:9810";
const DEFAULT_AUDIT_LOG = path.resolve("logs", "queue-recovery.ndjson");
function validateBatchId(batchId: string): string {
  const normalized = batchId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized)) {
    throw new Error(
      "batchId must be 8-128 characters using letters, numbers, '.', '_', ':', or '-'",
    );
  }
  return normalized;
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("limit must be an integer between 1 and 5000");
  }
  return limit;
}

async function runtimeDatabase(): Promise<RecoverySqliteDatabase> {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return (await getRuntimeSqliteCoreDatabase()).db;
}

function findCandidates(db: RecoverySqliteDatabase, limit: number): RecoveryCandidate[] {
  const params = [LARM_ENDPOINT_NEEDLE, limit + 1];
  return db
    .query(
      `
      select 'findingCandidate' as queue_name, 'finding_candidate_queue' as queue_table,
             id, attempt_count, updated_at, last_error
      from finding_candidate_queue
      where status = 'paused'
        and last_outcome_kind = 'provider_unavailable_exhausted'
        and instr(coalesce(last_error, ''), ?) > 0
        and (
          instr(lower(coalesce(last_error, '')), 'no route to host') > 0
          or instr(lower(coalesce(last_error, '')), 'os error 65') > 0
        )
      union all
      select 'episodeDistiller' as queue_name, 'episode_distiller_queue' as queue_table,
             id, attempt_count, updated_at, last_error
      from episode_distiller_queue
      where status = 'paused'
        and last_outcome_kind = 'provider_unavailable_exhausted'
        and instr(coalesce(last_error, ''), ?) > 0
      order by updated_at asc, id asc
      limit ?
    `,
    )
    .all(LARM_ENDPOINT_NEEDLE, ...params) as RecoveryCandidate[];
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requeueCandidates(
  db: RecoverySqliteDatabase,
  limit: number,
  batchId: string,
  requestedAt: string,
): void {
  const reason = `LARM recovery batch ${batchId}`;
  const endpoint = sqliteLiteral(LARM_ENDPOINT_NEEDLE);
  const batch = sqliteLiteral(batchId);
  const kind = sqliteLiteral(LARM_RECOVERY_KIND);
  const timestamp = sqliteLiteral(requestedAt);
  const recoveryReason = sqliteLiteral(reason);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    DROP TABLE IF EXISTS temp.larm_recovery_candidates;
    CREATE TEMP TABLE larm_recovery_candidates (
      queue_name TEXT NOT NULL,
      queue_job_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (queue_name, queue_job_id)
    );
    INSERT INTO temp.larm_recovery_candidates (queue_name, queue_job_id, updated_at)
    SELECT queue_name, queue_job_id, updated_at
    FROM (
      SELECT 'findingCandidate' AS queue_name, id AS queue_job_id, updated_at
      FROM finding_candidate_queue
      WHERE status = 'paused'
        AND last_outcome_kind = 'provider_unavailable_exhausted'
        AND instr(coalesce(last_error, ''), ${endpoint}) > 0
        AND (
          instr(lower(coalesce(last_error, '')), 'no route to host') > 0
          OR instr(lower(coalesce(last_error, '')), 'os error 65') > 0
        )
      UNION ALL
      SELECT 'episodeDistiller' AS queue_name, id AS queue_job_id, updated_at
      FROM episode_distiller_queue
      WHERE status = 'paused'
        AND last_outcome_kind = 'provider_unavailable_exhausted'
        AND instr(coalesce(last_error, ''), ${endpoint}) > 0
    )
    ORDER BY updated_at ASC, queue_job_id ASC
    LIMIT ${limit};

    INSERT INTO distillation_queue_events (
      id, queue_name, queue_job_id, event_type, message, metadata, created_at
    )
    SELECT lower(hex(randomblob(16))), queue_name, queue_job_id, 'requeued',
           ${recoveryReason},
           json_object(
             'recoveryBatchId', ${batch},
             'recoveryKind', ${kind},
             'endpoint', ${endpoint},
             'previousStatus', 'paused',
             'previousOutcomeKind', 'provider_unavailable_exhausted',
             'previousErrorClass', CASE queue_name
               WHEN 'findingCandidate' THEN 'tcp_no_route_os_code_65'
               ELSE 'larm_connect'
             END
           ),
           ${timestamp}
    FROM temp.larm_recovery_candidates;

    UPDATE finding_candidate_queue
      set status = 'pending',
          attempt_count = 0,
          next_run_at = null,
          completed_at = null,
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          last_error = ${recoveryReason},
          last_outcome_kind = 'provider_recovery_requeued',
          payload = json_set(
            coalesce(nullif(payload, ''), '{}'),
            '$.recoveryBatchId', ${batch},
            '$.recoveryKind', ${kind},
            '$.retryRequestedAt', ${timestamp}
          ),
          updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT queue_job_id FROM temp.larm_recovery_candidates
      WHERE queue_name = 'findingCandidate'
    );

    UPDATE episode_distiller_queue
    SET status = 'pending',
        attempt_count = 0,
        next_run_at = null,
        completed_at = null,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        last_error = ${recoveryReason},
        last_outcome_kind = 'provider_recovery_requeued',
        payload = json_set(
          coalesce(nullif(payload, ''), '{}'),
          '$.recoveryBatchId', ${batch},
          '$.recoveryKind', ${kind},
          '$.retryRequestedAt', ${timestamp}
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT queue_job_id FROM temp.larm_recovery_candidates
      WHERE queue_name = 'episodeDistiller'
    );

    DROP TABLE temp.larm_recovery_candidates;
  `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function recoverLarmProviderFailures(
  input: { mode: "dry-run" | "write"; limit: number; batchId: string },
  database?: RecoverySqliteDatabase,
): Promise<LarmRecoveryResult> {
  const limit = validateLimit(input.limit);
  const batchId = validateBatchId(input.batchId);
  if (input.mode !== "dry-run" && input.mode !== "write") {
    throw new Error("mode must be dry-run or write");
  }
  const db = database ?? (await runtimeDatabase());
  const startedAt = new Date().toISOString();
  const discovered = findCandidates(db, limit);
  const hasMore = discovered.length > limit;
  const candidates = discovered.slice(0, limit);
  const byQueue: LarmRecoveryResult["byQueue"] = {
    findingCandidate: 0,
    episodeDistiller: 0,
  };
  for (const candidate of candidates) byQueue[candidate.queue_name] += 1;

  if (input.mode === "dry-run") {
    return {
      mode: input.mode,
      batchId,
      requestedLimit: limit,
      matched: candidates.length,
      hasMore,
      requeued: 0,
      skipped: 0,
      byQueue,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const existingBatchSize = batchEvents(db, batchId).length;
  requeueCandidates(db, limit, batchId, startedAt);
  const requeued = batchEvents(db, batchId).length - existingBatchSize;
  const skipped = Math.max(0, candidates.length - requeued);

  return {
    mode: input.mode,
    batchId,
    requestedLimit: limit,
    matched: candidates.length,
    hasMore,
    requeued,
    skipped,
    byQueue,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function batchEvents(db: RecoverySqliteDatabase, batchId: string): RecoveryEventRow[] {
  return db
    .query(
      `
      select queue_name, queue_job_id, created_at
      from distillation_queue_events
      where event_type = 'requeued'
        and json_extract(case when json_valid(metadata) then metadata else '{}' end, '$.recoveryKind') = ?
        and json_extract(case when json_valid(metadata) then metadata else '{}' end, '$.recoveryBatchId') = ?
      order by created_at asc, queue_name asc, queue_job_id asc
    `,
    )
    .all(LARM_RECOVERY_KIND, batchId) as RecoveryEventRow[];
}

export async function traceLarmRecoveryBatch(
  requestedBatchId: string,
  database?: RecoverySqliteDatabase,
): Promise<LarmRecoveryTrace> {
  const batchId = validateBatchId(requestedBatchId);
  const db = database ?? (await runtimeDatabase());
  const batch = batchEvents(db, batchId);
  if (batch.length === 0) throw new Error(`recovery batch not found: ${batchId}`);
  const firstRequeuedAt = batch[0]?.created_at ?? null;
  const lastRequeuedAt = batch.at(-1)?.created_at ?? null;
  const states = db
    .query(
      `
        select queue_name, status, last_outcome_kind, count(*) as count
        from (
          select b.queue_name, q.status, q.last_outcome_kind
          from distillation_queue_events b
          join finding_candidate_queue q
            on b.queue_name = 'findingCandidate' and q.id = b.queue_job_id
          where b.event_type = 'requeued'
            and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryKind') = ?
            and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryBatchId') = ?
          union all
          select b.queue_name, q.status, q.last_outcome_kind
          from distillation_queue_events b
          join episode_distiller_queue q
            on b.queue_name = 'episodeDistiller' and q.id = b.queue_job_id
          where b.event_type = 'requeued'
            and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryKind') = ?
            and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryBatchId') = ?
        )
        group by queue_name, status, last_outcome_kind
        order by queue_name, status, last_outcome_kind
      `,
    )
    .all(LARM_RECOVERY_KIND, batchId, LARM_RECOVERY_KIND, batchId) as Array<
    QueueStateRow & { queue_name: string }
  >;
  const events = db
    .query(
      `
        select e.event_type, count(*) as count
        from distillation_queue_events e
        join distillation_queue_events b
          on b.queue_name = e.queue_name and b.queue_job_id = e.queue_job_id
        where b.event_type = 'requeued'
          and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryKind') = ?
          and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryBatchId') = ?
          and datetime(e.created_at) >= datetime(b.created_at)
        group by e.event_type
        order by e.event_type
      `,
    )
    .all(LARM_RECOVERY_KIND, batchId) as EventCountRow[];
  const leases = db
    .query(
      `
        select l.target_id, l.status, l.release_reason, count(*) as count
        from llm_provider_leases l
        join distillation_queue_events b
          on b.queue_name = l.queue_name and b.queue_job_id = l.queue_job_id
        where b.event_type = 'requeued'
          and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryKind') = ?
          and json_extract(case when json_valid(b.metadata) then b.metadata else '{}' end, '$.recoveryBatchId') = ?
          and datetime(l.created_at) >= datetime(b.created_at)
        group by l.target_id, l.status, l.release_reason
        order by l.target_id, l.status, l.release_reason
      `,
    )
    .all(LARM_RECOVERY_KIND, batchId) as LeaseCountRow[];
  const failures = db
    .query(
      `
      with batch as (
        select queue_name, queue_job_id
        from distillation_queue_events
        where event_type = 'requeued'
          and json_extract(case when json_valid(metadata) then metadata else '{}' end, '$.recoveryKind') = ?
          and json_extract(case when json_valid(metadata) then metadata else '{}' end, '$.recoveryBatchId') = ?
      ), current_jobs as (
        select b.queue_name, q.status, q.last_outcome_kind, q.last_error
        from batch b
        join finding_candidate_queue q
          on b.queue_name = 'findingCandidate' and q.id = b.queue_job_id
        union all
        select b.queue_name, q.status, q.last_outcome_kind, q.last_error
        from batch b
        join episode_distiller_queue q
          on b.queue_name = 'episodeDistiller' and q.id = b.queue_job_id
      )
      select queue_name, status,
             case
               when lower(coalesce(last_error, '')) like '%no route to host%'
                 or lower(coalesce(last_error, '')) like '%os error 65%' then 'tcp_no_route'
               when lower(coalesce(last_error, '')) like '%connection refused%'
                 or lower(coalesce(last_error, '')) like '%tcp connect%' then 'tcp_connect'
               when lower(coalesce(last_error, '')) like '%http 429%'
                 or lower(coalesce(last_error, '')) like '%queue_timeout%' then 'http_429_queue_timeout'
               when lower(coalesce(last_error, '')) like '%http 503%' then 'http_503'
               when lower(coalesce(last_error, '')) like '%structured_output_incomplete%'
                 then 'structured_output_incomplete'
               when last_outcome_kind = 'provider_unavailable_retry' then 'provider_unavailable_retry'
               else 'other'
             end as reason,
             count(*) as count
      from current_jobs
      where status = 'failed' or last_outcome_kind = 'provider_unavailable_retry'
      group by queue_name, status, reason
      order by queue_name, status, reason
    `,
    )
    .all(LARM_RECOVERY_KIND, batchId) as FailureCountRow[];
  return {
    traceVersion: "datetime-normalized-v1",
    batchId,
    requeued: batch.length,
    firstRequeuedAt,
    lastRequeuedAt,
    states: states.map((row) => ({
      queueName: row.queue_name,
      status: row.status,
      outcome: row.last_outcome_kind,
      count: Number(row.count),
    })),
    events: events.map((row) => ({ eventType: row.event_type, count: Number(row.count) })),
    failures: failures.map((row) => ({
      queueName: row.queue_name,
      status: row.status,
      reason: row.reason,
      count: Number(row.count),
    })),
    leases: leases.map((row) => ({
      targetId: row.target_id,
      status: row.status,
      releaseReason: row.release_reason,
      count: Number(row.count),
    })),
    tracedAt: new Date().toISOString(),
  };
}

export async function appendRecoveryAuditLog(
  record: { action: "requeue" | "trace"; result: LarmRecoveryResult | LarmRecoveryTrace },
  logPath = DEFAULT_AUDIT_LOG,
): Promise<string> {
  const resolved = path.resolve(logPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await appendFile(
    resolved,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return resolved;
}
