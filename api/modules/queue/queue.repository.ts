import { sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import {
  appendQueueEvent,
  getQueueControlStates,
  pauseRunningQueueJobs,
  pauseQueueJob,
  resumeQueueJob,
  retryQueueJob,
  setQueuePaused,
} from "../../../src/modules/queue/core/index.js";
import { resolveCoverEvidenceRouteByPolicy } from "../../../src/modules/coverEvidence/provider-policy.js";
import {
  resolveDistillationModel,
  type DistillationProviderSetting,
} from "../../../src/modules/distillation/distillation-runtime.service.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
  resolveCoverEvidenceRoutes,
  resolveFindCandidateRoute,
} from "../../../src/modules/settings/settings.service.js";
import {
  distillationQueueNames,
  distillationQueueStatuses,
  queueTableNameByQueue,
  type DistillationQueueName,
  type DistillationQueueStatus,
  type QueueListItem,
  type QueueRetryMode,
  type QueueStatsByQueue,
} from "../../../src/modules/queue/core/types.js";

export type QueueListQuery = {
  page: number;
  limit: number;
  query?: string;
  queue?: DistillationQueueName;
  status?: DistillationQueueStatus | "all";
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

export type QueueControlState = {
  paused: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
};

export type QueueControlStatesByQueue = Record<DistillationQueueName, QueueControlState>;

type QueueStatsAggregateRow = {
  status: string;
  count: number;
  oldest_pending_at: Date | string | number | null;
  escalated_count: number;
  offline_count: number;
  non_registered_count: number;
};

type QueueListRow = {
  id: string;
  status: string;
  priority: number;
  attempt_count: number;
  subject_title: string | null;
  subject_detail: string | null;
  provider: string | null;
  model: string | null;
  last_error: string | null;
  last_outcome_kind: string | null;
  locked_by: string | null;
  locked_at: Date | string | number | null;
  heartbeat_at: Date | string | number | null;
  created_at: Date | string | number;
  updated_at: Date | string | number;
  completed_at: Date | string | number | null;
  next_run_at: Date | string | number | null;
  metadata_summary: string | null;
  source_kind: string | null;
  provider_policy: string | null;
};

function emptyCounters(): Record<DistillationQueueStatus, number> {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    paused: 0,
  };
}

function toIsoTimestamp(value: Date | string | number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Driver-parsed `timestamp without time zone` values are interpreted as local time.
    // Rebuild as UTC wall-clock to avoid local offset drift in API responses.
    const rebuiltUtc = new Date(
      Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      ),
    );
    return Number.isNaN(rebuiltUtc.getTime()) ? null : rebuiltUtc.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // PostgreSQL timestamp (without timezone) should be treated as UTC to avoid local offset drift.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
      const parsedUtc = new Date(`${trimmed.replace(" ", "T")}Z`);
      return Number.isNaN(parsedUtc.getTime()) ? null : parsedUtc.toISOString();
    }
    const parsedString = new Date(trimmed);
    return Number.isNaN(parsedString.getTime()) ? null : parsedString.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRow(queueName: DistillationQueueName, row: QueueListRow): QueueListItem {
  const createdAt =
    toIsoTimestamp(row.created_at) ?? toIsoTimestamp(row.updated_at) ?? new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(row.updated_at) ?? createdAt;
  const resolved = resolveQueueRuntimeModel(queueName, row);
  return {
    queueName,
    id: row.id,
    status: row.status as DistillationQueueStatus,
    priority: Number(row.priority ?? 50),
    attemptCount: Number(row.attempt_count ?? 0),
    subjectTitle: row.subject_title ?? "-",
    subjectDetail: row.subject_detail ?? "-",
    provider: resolved.provider,
    model: resolved.model,
    lastError: row.last_error ?? null,
    lastOutcomeKind: row.last_outcome_kind ?? null,
    lockedBy: row.locked_by ?? null,
    lockedAt: toIsoTimestamp(row.locked_at),
    heartbeatAt: toIsoTimestamp(row.heartbeat_at),
    createdAt,
    updatedAt,
    completedAt: toIsoTimestamp(row.completed_at),
    nextRunAt: toIsoTimestamp(row.next_run_at),
    metadataSummary: row.metadata_summary ?? null,
  };
}

function normalizeProviderPolicy(value: string | null): "default" | "cloud_api" {
  return value === "cloud_api" ? "cloud_api" : "default";
}

function resolveRouteModel(provider: string, configuredModel: string | undefined): string | null {
  const model = configuredModel?.trim();
  if (model) return model;
  try {
    return resolveDistillationModel(provider as DistillationProviderSetting);
  } catch {
    return null;
  }
}

function resolveQueueRuntimeModel(
  queueName: DistillationQueueName,
  row: QueueListRow,
): { provider: string | null; model: string | null } {
  if (row.model?.trim()) {
    return { provider: row.provider ?? null, model: row.model.trim() };
  }

  if (queueName === "findingCandidate") {
    const sourceKind = row.source_kind === "vibe_memory" ? "vibe_memory" : "wiki_file";
    const route = resolveFindCandidateRoute(sourceKind);
    const provider = route.provider;
    return { provider, model: resolveRouteModel(provider, route.model) };
  }

  if (queueName === "coveringEvidence" || queueName === "premiumCoveringEvidence") {
    const policy = normalizeProviderPolicy(row.provider_policy);
    const routes = resolveCoverEvidenceRoutes();
    try {
      const route = resolveCoverEvidenceRouteByPolicy({
        route: routes.externalEvidence,
        policy,
        routeName: "externalEvidence",
      });
      const provider = route.provider;
      return { provider, model: resolveRouteModel(provider, route.model) };
    } catch {
      const provider = row.provider ?? null;
      return { provider, model: provider ? resolveRouteModel(provider, undefined) : null };
    }
  }

  const settings = getRuntimeSettingsSnapshot();
  const finalizeRoute = settings.taskRouting.finalizeDistille;
  const provider = finalizeRoute.provider;
  return { provider, model: resolveRouteModel(provider, finalizeRoute.model) };
}

function buildDynamicOrderBy(
  queueName: DistillationQueueName,
  sortBy: string | null | undefined,
  sortDir: "asc" | "desc" | undefined,
) {
  const allowedFields = ["status", "priority", "subjectTitle", "attemptCount", "updatedAt"];
  const field = sortBy && allowedFields.includes(sortBy) ? sortBy : null;
  const dir = sortDir === "asc" || sortDir === "desc" ? sortDir : "desc";

  if (!field) {
    return sql`
      case
        when q.status = 'running' then 0
        when q.status = 'pending' then 1
        when q.status = 'paused' then 2
        when q.status = 'failed' then 3
        else 4
      end,
      q.priority desc,
      q.updated_at desc
    `;
  }

  let sortColumn;
  switch (field) {
    case "status":
      sortColumn = sql`q.status`;
      break;
    case "priority":
      sortColumn = sql`q.priority`;
      break;
    case "attemptCount":
      sortColumn = sql`q.attempt_count`;
      break;
    case "updatedAt":
      sortColumn = sql`q.updated_at`;
      break;
    case "subjectTitle":
      if (queueName === "findingCandidate") {
        sortColumn = sql`q.source_key`;
      } else if (queueName === "coveringEvidence" || queueName === "premiumCoveringEvidence") {
        sortColumn = sql`c.title`;
      } else {
        sortColumn = sql`coalesce(e.title, c.title)`;
      }
      break;
    default:
      sortColumn = sql`q.updated_at`;
  }

  return dir === "asc"
    ? sql`${sortColumn} asc, q.updated_at desc`
    : sql`${sortColumn} desc, q.updated_at desc`;
}

async function queryQueueRows(
  queueName: DistillationQueueName,
  params: {
    limit: number;
    offset: number;
    query?: string;
    status?: DistillationQueueStatus | "all";
    sortBy?: string;
    sortDir?: "asc" | "desc";
  },
): Promise<QueueListRow[]> {
  const pattern = params.query?.trim() ? `%${params.query.trim()}%` : null;
  const statusFilter = params.status && params.status !== "all" ? params.status : null;
  const { sortBy, sortDir } = params;

  if (queueName === "findingCandidate") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        q.source_key as subject_title,
        concat(q.source_kind, ' | ', coalesce(q.source_uri, '')) as subject_detail,
        null::text as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        concat('input=', q.input_kind) as metadata_summary,
        q.source_kind,
        null::text as provider_policy
      from finding_candidate_queue q
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or q.source_key ilike ${pattern}
          or q.source_uri ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("findingCandidate", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "coveringEvidence") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        c.title as subject_title,
        concat('candidate=', q.found_candidate_id, ' | policy=', q.provider_policy) as subject_detail,
        q.provider_policy as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        null::text as metadata_summary,
        null::text as source_kind,
        q.provider_policy
      from covering_evidence_queue q
      left join found_candidates c on c.id = q.found_candidate_id
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or c.title ilike ${pattern}
          or q.found_candidate_id::text ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("coveringEvidence", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "premiumCoveringEvidence") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        c.title as subject_title,
        concat(
          'candidate=', q.found_candidate_id,
          ' | sourceCovering=', coalesce(q.source_covering_job_id::text, '-')
        ) as subject_detail,
        q.provider_policy as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        q.payload ->> 'escalationReason' as metadata_summary,
        null::text as source_kind,
        q.provider_policy
      from premium_covering_evidence_queue q
      left join found_candidates c on c.id = q.found_candidate_id
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or c.title ilike ${pattern}
          or q.found_candidate_id::text ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("premiumCoveringEvidence", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  const result = await db.execute(sql`
    select
      q.id,
      q.status,
      q.priority,
      q.attempt_count,
      coalesce(e.title, c.title) as subject_title,
      concat(
        'evidence=', q.evidence_result_id,
        ' | knowledge=', coalesce(q.knowledge_id::text, '-')
      ) as subject_detail,
      q.provider_policy as provider,
      null::text as model,
      q.last_error,
      q.last_outcome_kind,
      q.locked_by,
      q.locked_at,
      q.heartbeat_at,
      q.created_at,
      q.updated_at,
      q.completed_at,
      null::timestamp as next_run_at,
      null::text as metadata_summary,
      null::text as source_kind,
      q.provider_policy
    from finalize_distille_queue q
    left join evidence_coverage_results e on e.id = q.evidence_result_id
    left join found_candidates c on c.id = e.found_candidate_id
    where (${statusFilter}::text is null or q.status = ${statusFilter})
      and (
        ${pattern}::text is null
        or coalesce(e.title, c.title) ilike ${pattern}
        or q.evidence_result_id::text ilike ${pattern}
      )
    order by
      ${buildDynamicOrderBy("finalizeDistille", sortBy, sortDir)}
    limit ${params.limit}
    offset ${params.offset}
  `);
  return result.rows as unknown as QueueListRow[];
}

async function countQueueRows(
  queueName: DistillationQueueName,
  params: { query?: string; status?: DistillationQueueStatus | "all" },
): Promise<number> {
  const pattern = params.query?.trim() ? `%${params.query.trim()}%` : null;
  const statusFilter = params.status && params.status !== "all" ? params.status : null;
  const tableName = queueTableNameByQueue[queueName];

  const column =
    queueName === "findingCandidate"
      ? sql`q.source_key || ' ' || coalesce(q.source_uri, '')`
      : queueName === "finalizeDistille"
        ? sql`coalesce(e.title, c.title, q.evidence_result_id::text)`
        : sql`coalesce(c.title, q.found_candidate_id::text)`;

  const joinSql =
    queueName === "findingCandidate"
      ? sql``
      : queueName === "finalizeDistille"
        ? sql`left join evidence_coverage_results e on e.id = q.evidence_result_id
              left join found_candidates c on c.id = e.found_candidate_id`
        : sql`left join found_candidates c on c.id = q.found_candidate_id`;

  const result = await db.execute(sql`
    select count(*)::int as count
    from ${sql.raw(tableName)} q
    ${joinSql}
    where (${statusFilter}::text is null or q.status = ${statusFilter})
      and (${pattern}::text is null or ${column} ilike ${pattern})
  `);
  const row = result.rows[0] as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function queueStatsFor(queueName: DistillationQueueName) {
  const tableName = queueTableNameByQueue[queueName];
  const result = await db.execute(sql`
    select
      status,
      count(*)::int as count,
      min(case when status = 'pending' then created_at end) as oldest_pending_at,
      count(*) filter (where last_outcome_kind = 'escalated_to_premium')::int as escalated_count,
      count(*) filter (
        where status = 'failed'
          and (
            coalesce(last_outcome_kind, '') = 'provider_failed'
            or coalesce(last_outcome_kind, '') like '%provider_timeout%'
            or coalesce(last_outcome_kind, '') like '%provider_failed%'
          )
      )::int as offline_count,
      count(*) filter (
        where status = 'completed'
          and coalesce(last_outcome_kind, '') = 'insufficient'
      )::int as non_registered_count
    from ${sql.raw(tableName)}
    group by status
  `);
  const rows = result.rows as unknown as QueueStatsAggregateRow[];
  const counters = emptyCounters();
  let oldestPendingAt: string | null = null;
  let escalated = 0;
  let offline = 0;
  let nonRegistered = 0;
  for (const row of rows) {
    if (distillationQueueStatuses.includes(row.status as DistillationQueueStatus)) {
      counters[row.status as DistillationQueueStatus] = Number(row.count ?? 0);
    }
    if (!oldestPendingAt) {
      const normalized = toIsoTimestamp(row.oldest_pending_at);
      if (normalized) {
        oldestPendingAt = normalized;
      }
    }
    escalated += Number(row.escalated_count ?? 0);
    offline += Number(row.offline_count ?? 0);
    nonRegistered += Number(row.non_registered_count ?? 0);
  }
  if (queueName !== "coveringEvidence" && queueName !== "premiumCoveringEvidence") {
    nonRegistered = 0;
  }
  return {
    counters,
    oldestPendingAt,
    running: counters.running,
    failed: counters.failed,
    offline,
    nonRegistered,
    escalated,
  };
}

export async function fetchQueueDashboardStats(): Promise<{
  queues: QueueStatsByQueue;
  totals: QueueStatsByQueue[DistillationQueueName];
  queueControls: QueueControlStatesByQueue;
}> {
  const [values, queueControls] = await Promise.all([
    Promise.all(distillationQueueNames.map((queueName) => queueStatsFor(queueName))),
    getQueueControlStates(),
  ]);
  const queues = Object.fromEntries(
    distillationQueueNames.map((queueName, index) => [queueName, values[index]]),
  ) as QueueStatsByQueue;

  const totals = {
    counters: emptyCounters(),
    oldestPendingAt: null,
    running: 0,
    failed: 0,
    offline: 0,
    nonRegistered: 0,
    escalated: 0,
  } as QueueStatsByQueue[DistillationQueueName];

  for (const queueName of distillationQueueNames) {
    const snapshot = queues[queueName];
    for (const status of distillationQueueStatuses) {
      totals.counters[status] += snapshot.counters[status];
    }
    totals.running += snapshot.running;
    totals.failed += snapshot.failed;
    totals.offline += snapshot.offline;
    totals.nonRegistered += snapshot.nonRegistered;
    totals.escalated += snapshot.escalated;
    if (snapshot.oldestPendingAt) {
      if (
        !totals.oldestPendingAt ||
        Date.parse(snapshot.oldestPendingAt) < Date.parse(totals.oldestPendingAt)
      ) {
        totals.oldestPendingAt = snapshot.oldestPendingAt;
      }
    }
  }

  return { queues, totals, queueControls };
}

export async function listQueueItems(params: QueueListQuery) {
  await ensureRuntimeSettingsLoaded();
  const queueName = params.queue ?? "findingCandidate";
  const page = Math.max(1, params.page);
  const limit = Math.max(1, Math.min(100, params.limit));
  const offset = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    queryQueueRows(queueName, {
      limit,
      offset,
      query: params.query,
      status: params.status,
      sortBy: params.sortBy,
      sortDir: params.sortDir,
    }),
    countQueueRows(queueName, {
      query: params.query,
      status: params.status,
    }),
  ]);

  return {
    queue: queueName,
    items: rows.map((row) => normalizeRow(queueName, row)),
    total,
    page,
    limit,
  };
}

export async function fetchActiveTasks(): Promise<QueueListItem[]> {
  await ensureRuntimeSettingsLoaded();
  const responses = await Promise.all(
    distillationQueueNames.map((queueName) =>
      queryQueueRows(queueName, { limit: 50, offset: 0, status: "running" }),
    ),
  );

  return responses
    .flatMap((rows, index) => rows.map((row) => normalizeRow(distillationQueueNames[index], row)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function pauseTarget(queueName: DistillationQueueName, id: string, reason: string) {
  const row = await pauseQueueJob({ queueName, id, reason });
  if (!row) return null;
  await appendQueueEvent({
    queueName,
    queueJobId: id,
    eventType: "paused",
    message: reason,
  });
  return row;
}

export async function resumeTarget(queueName: DistillationQueueName, id: string) {
  const row = await resumeQueueJob({ queueName, id });
  if (!row) return null;
  await appendQueueEvent({
    queueName,
    queueJobId: id,
    eventType: "resumed",
    message: "resumed from queue control",
  });
  return row;
}

export async function retryTarget(params: {
  queueName: DistillationQueueName;
  id: string;
  mode: QueueRetryMode;
  forceRefreshEvidence: boolean;
  reason?: string;
}) {
  const row = await retryQueueJob(params);
  if (!row) return null;
  await appendQueueEvent({
    queueName: params.queueName,
    queueJobId: params.id,
    eventType: "retried",
    message: params.reason ?? null,
    metadata: {
      mode: params.mode,
      forceRefreshEvidence: params.forceRefreshEvidence,
    },
  });
  return row;
}

export async function pauseQueueLane(queueName: DistillationQueueName, reason?: string) {
  const queueControls = await setQueuePaused({
    queueName,
    paused: true,
    reason,
    updatedBy: "queue-dashboard",
  });

  const pausedRunningCount = await pauseRunningQueueJobs({
    queueName,
    reason: reason ?? "paused from queue lane control",
  });

  return {
    queueName,
    state: queueControls[queueName],
    pausedRunningCount,
  };
}

export async function resumeQueueLane(queueName: DistillationQueueName, reason?: string) {
  const queueControls = await setQueuePaused({
    queueName,
    paused: false,
    reason,
    updatedBy: "queue-dashboard",
  });

  return {
    queueName,
    state: queueControls[queueName],
    reason: reason ?? null,
  };
}
