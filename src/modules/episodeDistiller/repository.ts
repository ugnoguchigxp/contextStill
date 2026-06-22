import { and, eq, sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { episodeDistillerQueue } from "../../db/schema.js";
import { appendQueueEvent } from "../queue/core/events.js";

export type EpisodeDistillerJob = typeof episodeDistillerQueue.$inferSelect;

export type EpisodeDistillerRepairCandidate = {
  id: string;
  sourceKey: string;
  status: string;
  reason: "missing_episode_cards" | "legacy_evidence_status_failure";
  expectedEpisodeIds: string[];
  missingEpisodeIds: string[];
  lastError: string | null;
  updatedAt: Date | null;
};

export type RequeueEpisodeDistillerRepairResult = {
  write: boolean;
  scanned: number;
  requeued: number;
  items: EpisodeDistillerRepairCandidate[];
};

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sqliteDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function sqliteEpisodeDistillerJobRow(row: Record<string, unknown>): EpisodeDistillerJob {
  return {
    id: String(row.id),
    sourceKind: String(row.source_kind),
    sourceKey: String(row.source_key),
    sourceUri: String(row.source_uri),
    distillationVersion: String(row.distillation_version),
    payload: parseJsonRecord(row.payload),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 2),
    providerPolicy: row.provider_policy ? String(row.provider_policy) : "default",
    nextRunAt: sqliteDate(row.next_run_at),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: sqliteDate(row.locked_at),
    heartbeatAt: sqliteDate(row.heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
    metadata: parseJsonRecord(row.metadata),
    createdAt: sqliteDate(row.created_at) ?? new Date(0),
    updatedAt: sqliteDate(row.updated_at) ?? new Date(0),
    completedAt: sqliteDate(row.completed_at),
  };
}

export async function getEpisodeDistillerJobById(
  jobId: string,
): Promise<EpisodeDistillerJob | null> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query("select * from episode_distiller_queue where id = ? limit 1")
      .get(jobId) as Record<string, unknown> | null;
    return row ? sqliteEpisodeDistillerJobRow(row) : null;
  }
  const [row] = await db
    .select()
    .from(episodeDistillerQueue)
    .where(eq(episodeDistillerQueue.id, jobId))
    .limit(1);
  return row ?? null;
}

export async function enqueueEpisodeDistillerJob(params: {
  sourceKind?: "vibe_memory";
  sourceKey: string;
  sourceUri?: string;
  distillationVersion?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority?: number;
}): Promise<EpisodeDistillerJob> {
  const sourceKind = params.sourceKind ?? "vibe_memory";
  const sourceUri = params.sourceUri ?? `vibe_memory:${params.sourceKey}`;
  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  const priority = params.priority ?? 50;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    const existing = sqlite.db
      .query(
        `
        select *
        from episode_distiller_queue
        where source_kind = ?
          and source_key = ?
          and distillation_version = ?
        limit 1
      `,
      )
      .get(sourceKind, params.sourceKey, distillationVersion) as Record<string, unknown> | null;
    const id = existing?.id ? String(existing.id) : crypto.randomUUID();
    if (existing) {
      sqlite.db
        .query(
          `
          update episode_distiller_queue
          set source_uri = ?,
              payload = ?,
              metadata = ?,
              priority = ?,
              provider_policy = coalesce(provider_policy, 'default'),
              next_run_at = null,
              completed_at = null,
              status = case when status = 'running' then status else 'pending' end,
              locked_by = case when status = 'running' then locked_by else null end,
              locked_at = case when status = 'running' then locked_at else null end,
              heartbeat_at = case when status = 'running' then heartbeat_at else null end,
              updated_at = ?
          where id = ?
        `,
        )
        .run(
          sourceUri,
          JSON.stringify(params.payload ?? {}),
          JSON.stringify(params.metadata ?? {}),
          priority,
          now,
          id,
        );
    } else {
      sqlite.db
        .query(
          `
          insert into episode_distiller_queue (
            id, source_kind, source_key, source_uri, distillation_version,
            payload, metadata, priority, provider_policy, status, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, 'default', 'pending', ?, ?)
        `,
        )
        .run(
          id,
          sourceKind,
          params.sourceKey,
          sourceUri,
          distillationVersion,
          JSON.stringify(params.payload ?? {}),
          JSON.stringify(params.metadata ?? {}),
          priority,
          now,
          now,
        );
    }
    const row = sqlite.db
      .query("select * from episode_distiller_queue where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    if (!row) throw new Error("failed to enqueue episode distiller job");
    const normalized = sqliteEpisodeDistillerJobRow(row);
    await appendQueueEvent({
      queueName: "episodeDistiller",
      queueJobId: normalized.id,
      eventType: "enqueued",
      message: "episode distiller enqueued",
      metadata: {
        sourceKind: normalized.sourceKind,
        sourceKey: normalized.sourceKey,
      },
    });
    return normalized;
  }

  const [row] = await db
    .insert(episodeDistillerQueue)
    .values({
      sourceKind,
      sourceKey: params.sourceKey,
      sourceUri,
      distillationVersion,
      payload: params.payload ?? {},
      metadata: params.metadata ?? {},
      priority,
      providerPolicy: "default",
      status: "pending",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        episodeDistillerQueue.sourceKind,
        episodeDistillerQueue.sourceKey,
        episodeDistillerQueue.distillationVersion,
      ],
      set: {
        sourceUri,
        payload: params.payload ?? {},
        metadata: params.metadata ?? {},
        priority,
        nextRunAt: null,
        completedAt: null,
        status: sql`case when ${episodeDistillerQueue.status} = 'running' then ${episodeDistillerQueue.status} else 'pending' end`,
        lockedBy: sql`case when ${episodeDistillerQueue.status} = 'running' then ${episodeDistillerQueue.lockedBy} else null end`,
        lockedAt: sql`case when ${episodeDistillerQueue.status} = 'running' then ${episodeDistillerQueue.lockedAt} else null end`,
        heartbeatAt: sql`case when ${episodeDistillerQueue.status} = 'running' then ${episodeDistillerQueue.heartbeatAt} else null end`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("failed to enqueue episode distiller job");
  await appendQueueEvent({
    queueName: "episodeDistiller",
    queueJobId: row.id,
    eventType: "enqueued",
    message: "episode distiller enqueued",
    metadata: {
      sourceKind: row.sourceKind,
      sourceKey: row.sourceKey,
    },
  });
  return row;
}

export async function markEpisodeDistillerCompleted(params: {
  jobId: string;
  outcome: string;
  metadata?: Record<string, unknown>;
  status?: "completed" | "skipped";
}): Promise<void> {
  const status = params.status ?? "completed";
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update episode_distiller_queue
        set status = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = CURRENT_TIMESTAMP,
            last_error = null,
            last_outcome_kind = ?,
            metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?),
            updated_at = CURRENT_TIMESTAMP
        where id = ?
      `,
      )
      .run(status, params.outcome, JSON.stringify(params.metadata ?? {}), params.jobId);
    return;
  }
  const current = await getEpisodeDistillerJobById(params.jobId);
  await db
    .update(episodeDistillerQueue)
    .set({
      status,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
      lastError: null,
      lastOutcomeKind: params.outcome,
      metadata: {
        ...(current?.metadata as Record<string, unknown> | undefined),
        ...params.metadata,
      },
      updatedAt: new Date(),
    })
    .where(eq(episodeDistillerQueue.id, params.jobId));
}

export async function markEpisodeDistillerFailed(params: {
  jobId: string;
  error: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const current = await getEpisodeDistillerJobById(params.jobId);
  const attemptCount = (current?.attemptCount ?? 0) + 1;
  const maxAttempts = current?.maxAttempts ?? 2;
  const terminal = attemptCount >= maxAttempts;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update episode_distiller_queue
        set status = ?,
            attempt_count = ?,
            next_run_at = case when ? then null else datetime('now', '+30 seconds') end,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = case when ? then CURRENT_TIMESTAMP else null end,
            last_error = ?,
            last_outcome_kind = ?,
            metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?),
            updated_at = CURRENT_TIMESTAMP
        where id = ?
      `,
      )
      .run(
        terminal ? "failed" : "pending",
        attemptCount,
        terminal ? 1 : 0,
        terminal ? 1 : 0,
        params.error.slice(0, 1000),
        params.outcome ?? "failed",
        JSON.stringify(params.metadata ?? {}),
        params.jobId,
      );
    return;
  }
  await db
    .update(episodeDistillerQueue)
    .set({
      status: terminal ? "failed" : "pending",
      attemptCount,
      nextRunAt: terminal ? null : new Date(Date.now() + 30_000),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: terminal ? new Date() : null,
      lastError: params.error.slice(0, 1000),
      lastOutcomeKind: params.outcome ?? "failed",
      metadata: {
        ...(current?.metadata as Record<string, unknown> | undefined),
        ...params.metadata,
      },
      updatedAt: new Date(),
    })
    .where(eq(episodeDistillerQueue.id, params.jobId));
}

export async function episodeDistillerJobExists(params: {
  sourceKind?: "vibe_memory";
  sourceKey: string;
  distillationVersion?: string;
}): Promise<boolean> {
  const sourceKind = params.sourceKind ?? "vibe_memory";
  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query<{ id: string }, [string, string, string]>(
        `
        select id
        from episode_distiller_queue
        where source_kind = ?
          and source_key = ?
          and distillation_version = ?
        limit 1
      `,
      )
      .get(sourceKind, params.sourceKey, distillationVersion);
    return Boolean(row?.id);
  }
  const [row] = await db
    .select({ id: episodeDistillerQueue.id })
    .from(episodeDistillerQueue)
    .where(
      and(
        eq(episodeDistillerQueue.sourceKind, sourceKind),
        eq(episodeDistillerQueue.sourceKey, params.sourceKey),
        eq(episodeDistillerQueue.distillationVersion, distillationVersion),
      ),
    )
    .limit(1);
  return Boolean(row?.id);
}

function mapRepairCandidate(row: Record<string, unknown>): EpisodeDistillerRepairCandidate {
  return {
    id: String(row.id),
    sourceKey: String(row.source_key),
    status: String(row.status),
    reason:
      row.reason === "legacy_evidence_status_failure"
        ? "legacy_evidence_status_failure"
        : "missing_episode_cards",
    expectedEpisodeIds: parseJsonStringArray(row.expected_episode_ids),
    missingEpisodeIds: parseJsonStringArray(row.missing_episode_ids),
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: sqliteDate(row.updated_at),
  };
}

export async function listEpisodeDistillerRepairCandidates(params?: {
  limit?: number;
}): Promise<EpisodeDistillerRepairCandidate[]> {
  const limit = params?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<Record<string, unknown>, [number]>(
        `
        select
          q.id,
          q.source_key,
          q.status,
          q.last_error,
          q.updated_at,
          case
            when q.status = 'failed'
              and lower(coalesce(q.last_error, '')) like '%episode_cards%'
              and lower(coalesce(q.last_error, '')) like '%evidence_status%'
              then 'legacy_evidence_status_failure'
            else 'missing_episode_cards'
          end as reason,
          coalesce((
            select json_group_array(cast(ids.value as text))
            from json_each(q.metadata, '$.episodeDistiller.episodeIds') ids
          ), '[]') as expected_episode_ids,
          coalesce((
            select json_group_array(cast(ids.value as text))
            from json_each(q.metadata, '$.episodeDistiller.episodeIds') ids
            where not exists (
              select 1 from episode_cards c where c.id = cast(ids.value as text)
            )
          ), '[]') as missing_episode_ids
        from episode_distiller_queue q
        where q.status <> 'running'
          and (
            (
              q.status = 'failed'
              and lower(coalesce(q.last_error, '')) like '%episode_cards%'
              and lower(coalesce(q.last_error, '')) like '%evidence_status%'
            )
            or (
              q.status = 'completed'
              and exists (
                select 1
                from json_each(q.metadata, '$.episodeDistiller.episodeIds') ids
                where not exists (
                  select 1 from episode_cards c where c.id = cast(ids.value as text)
                )
              )
            )
          )
        order by q.updated_at desc, q.id asc
        limit ?
      `,
      )
      .all(limit);
    return rows.map(mapRepairCandidate);
  }

  const result = await db.execute(sql`
    select
      q.id::text,
      q.source_key,
      q.status,
      q.last_error,
      q.updated_at,
      case
        when q.status = 'failed'
          and lower(coalesce(q.last_error, '')) like '%episode_cards%'
          and lower(coalesce(q.last_error, '')) like '%evidence_status%'
          then 'legacy_evidence_status_failure'
        else 'missing_episode_cards'
      end as reason,
      coalesce((
        select jsonb_agg(ids.value)
        from jsonb_array_elements_text(coalesce(q.metadata->'episodeDistiller'->'episodeIds', '[]'::jsonb)) ids(value)
      ), '[]'::jsonb)::text as expected_episode_ids,
      coalesce((
        select jsonb_agg(ids.value)
        from jsonb_array_elements_text(coalesce(q.metadata->'episodeDistiller'->'episodeIds', '[]'::jsonb)) ids(value)
        where not exists (
          select 1 from episode_cards c where c.id::text = ids.value
        )
      ), '[]'::jsonb)::text as missing_episode_ids
    from episode_distiller_queue q
    where q.status <> 'running'
      and (
        (
          q.status = 'failed'
          and lower(coalesce(q.last_error, '')) like '%episode_cards%'
          and lower(coalesce(q.last_error, '')) like '%evidence_status%'
        )
        or (
          q.status = 'completed'
          and exists (
            select 1
            from jsonb_array_elements_text(coalesce(q.metadata->'episodeDistiller'->'episodeIds', '[]'::jsonb)) ids(value)
            where not exists (
              select 1 from episode_cards c where c.id::text = ids.value
            )
          )
        )
      )
    order by q.updated_at desc, q.id asc
    limit ${limit}
  `);
  return (result.rows as Record<string, unknown>[]).map(mapRepairCandidate);
}

export async function requeueEpisodeDistillerRepairCandidates(params?: {
  limit?: number;
  write?: boolean;
  reason?: string;
}): Promise<RequeueEpisodeDistillerRepairResult> {
  const write = params?.write ?? false;
  const items = await listEpisodeDistillerRepairCandidates({ limit: params?.limit });
  let requeued = 0;
  if (!write) {
    return { write, scanned: items.length, requeued, items };
  }

  const reason =
    params?.reason ??
    "requeued because episodeDistiller completion did not leave matching episode_cards";
  for (const item of items) {
    const repairMetadata = {
      episodeDistillerRepair: {
        reason: item.reason,
        requeuedAt: new Date().toISOString(),
        previousStatus: item.status,
        expectedEpisodeIds: item.expectedEpisodeIds,
        missingEpisodeIds: item.missingEpisodeIds,
      },
    };
    if (isSqliteBackend()) {
      const sqlite = await getSqliteCoreDatabase();
      const result = sqlite.db
        .query(
          `
          update episode_distiller_queue
          set status = 'pending',
              attempt_count = 0,
              next_run_at = null,
              completed_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              last_error = ?,
              last_outcome_kind = 'episode_repair_requeued',
              metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?),
              updated_at = CURRENT_TIMESTAMP
          where id = ?
            and status <> 'running'
        `,
        )
        .run(reason, JSON.stringify(repairMetadata), item.id);
      if (result.changes === 0) continue;
    } else {
      const current = await getEpisodeDistillerJobById(item.id);
      await db
        .update(episodeDistillerQueue)
        .set({
          status: "pending",
          attemptCount: 0,
          nextRunAt: null,
          completedAt: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          lastError: reason,
          lastOutcomeKind: "episode_repair_requeued",
          metadata: {
            ...(current?.metadata as Record<string, unknown> | undefined),
            ...repairMetadata,
          },
          updatedAt: new Date(),
        })
        .where(eq(episodeDistillerQueue.id, item.id));
    }
    requeued += 1;
    await appendQueueEvent({
      queueName: "episodeDistiller",
      queueJobId: item.id,
      eventType: "retried",
      message: "episode distiller repair requeued",
      metadata: {
        reason: item.reason,
        expectedEpisodeIds: item.expectedEpisodeIds,
        missingEpisodeIds: item.missingEpisodeIds,
      },
    });
  }

  return { write, scanned: items.length, requeued, items };
}
