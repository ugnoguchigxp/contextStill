import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { landscapeSnapshots } from "../../db/schema.js";

export type LandscapeSnapshotCacheType =
  | "landscape_snapshot"
  | "landscape_replay_snapshot"
  | "landscape_replay_comparison";

type LandscapeSnapshotCacheRow = typeof landscapeSnapshots.$inferSelect;
export type LandscapeSnapshotCacheSummaryRow = {
  snapshotType: LandscapeSnapshotCacheType;
  readyCount: number;
  staleCount: number;
  expiredReadyCount: number;
  oldestGeneratedAt: Date | null;
  latestGeneratedAt: Date | null;
  latestExpiresAt: Date | null;
  estimatedPayloadBytes: number;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
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

function asDate(value: unknown): Date {
  const parsed = new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function emptyDeleteSummary(): {
  deletedCount: number;
  staleDeletedCount: number;
  expiredDeletedCount: number;
  bySnapshotType: Record<
    LandscapeSnapshotCacheType,
    { deletedCount: number; staleDeletedCount: number; expiredDeletedCount: number }
  >;
} {
  return {
    deletedCount: 0,
    staleDeletedCount: 0,
    expiredDeletedCount: 0,
    bySnapshotType: {
      landscape_snapshot: { deletedCount: 0, staleDeletedCount: 0, expiredDeletedCount: 0 },
      landscape_replay_snapshot: { deletedCount: 0, staleDeletedCount: 0, expiredDeletedCount: 0 },
      landscape_replay_comparison: {
        deletedCount: 0,
        staleDeletedCount: 0,
        expiredDeletedCount: 0,
      },
    },
  };
}

export async function findLandscapeSnapshotCache(input: {
  snapshotType: LandscapeSnapshotCacheType;
  paramsHash: string;
  now?: Date;
}): Promise<LandscapeSnapshotCacheRow | null> {
  const now = input.now ?? new Date();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query<
        {
          id: string;
          snapshot_type: string;
          status: string;
          params_hash: string;
          params: string;
          payload: string;
          generated_at: string;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        },
        [string, string, string]
      >(
        `
          select *
          from landscape_snapshots
          where snapshot_type = ?
            and params_hash = ?
            and status = 'ready'
            and (expires_at is null or datetime(expires_at) > datetime(?))
          order by datetime(generated_at) desc, datetime(updated_at) desc
          limit 1
        `,
      )
      .get(input.snapshotType, input.paramsHash, now.toISOString());
    if (!row) return null;
    return {
      id: row.id,
      snapshotType: row.snapshot_type,
      status: row.status,
      paramsHash: row.params_hash,
      params: parseJsonRecord(row.params),
      payload: parseJsonRecord(row.payload),
      generatedAt: asDate(row.generated_at),
      expiresAt: asNullableDate(row.expires_at),
      createdAt: asDate(row.created_at),
      updatedAt: asDate(row.updated_at),
    } as LandscapeSnapshotCacheRow;
  }

  const [row] = await db
    .select()
    .from(landscapeSnapshots)
    .where(
      and(
        eq(landscapeSnapshots.snapshotType, input.snapshotType),
        eq(landscapeSnapshots.paramsHash, input.paramsHash),
        eq(landscapeSnapshots.status, "ready"),
        or(isNull(landscapeSnapshots.expiresAt), gt(landscapeSnapshots.expiresAt, now)),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function upsertLandscapeSnapshotCache(input: {
  snapshotType: LandscapeSnapshotCacheType;
  paramsHash: string;
  params: Record<string, unknown>;
  payload: Record<string, unknown>;
  ttlSeconds: number;
  generatedAt?: Date;
}): Promise<void> {
  const now = input.generatedAt ?? new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, input.ttlSeconds) * 1000);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const paramsJson = JSON.stringify(input.params);
    const payloadJson = JSON.stringify(input.payload);
    const existing = sqlite.db
      .query<{ id: string }, [string, string]>(
        `
          select id
          from landscape_snapshots
          where snapshot_type = ?
            and params_hash = ?
          order by datetime(generated_at) desc, datetime(updated_at) desc
          limit 1
        `,
      )
      .get(input.snapshotType, input.paramsHash);
    if (existing) {
      sqlite.db
        .query(
          `
            update landscape_snapshots
            set status = 'ready',
                params = ?,
                payload = ?,
                generated_at = ?,
                expires_at = ?,
                updated_at = ?
            where id = ?
          `,
        )
        .run(
          paramsJson,
          payloadJson,
          now.toISOString(),
          expiresAt.toISOString(),
          now.toISOString(),
          existing.id,
        );
      return;
    }
    sqlite.db
      .query(
        `
          insert into landscape_snapshots (
            id, snapshot_type, status, params_hash, params, payload,
            generated_at, expires_at, created_at, updated_at
          ) values (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        input.snapshotType,
        input.paramsHash,
        paramsJson,
        payloadJson,
        now.toISOString(),
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    return;
  }

  await db
    .insert(landscapeSnapshots)
    .values({
      snapshotType: input.snapshotType,
      status: "ready",
      paramsHash: input.paramsHash,
      params: input.params,
      payload: input.payload,
      generatedAt: now,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [landscapeSnapshots.snapshotType, landscapeSnapshots.paramsHash],
      set: {
        status: "ready",
        params: input.params,
        payload: input.payload,
        generatedAt: now,
        expiresAt,
        updatedAt: now,
      },
    });
}

export async function markExpiredLandscapeSnapshotCacheAsStale(now = new Date()): Promise<number> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const result = sqlite.db
      .query(
        `
          update landscape_snapshots
          set status = 'stale',
              updated_at = ?
          where status = 'ready'
            and expires_at is not null
            and datetime(expires_at) <= datetime(?)
        `,
      )
      .run(now.toISOString(), now.toISOString());
    return Number(result.changes);
  }

  const result = await db
    .update(landscapeSnapshots)
    .set({
      status: "stale",
      updatedAt: now,
    })
    .where(
      and(
        eq(landscapeSnapshots.status, "ready"),
        sql`${landscapeSnapshots.expiresAt} IS NOT NULL`,
        sql`${landscapeSnapshots.expiresAt} <= ${now}`,
      ),
    )
    .returning({ id: landscapeSnapshots.id });

  return result.length;
}

export async function listLandscapeSnapshotCacheSummaryRows(): Promise<
  LandscapeSnapshotCacheSummaryRow[]
> {
  const now = new Date();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<
        {
          snapshot_type: LandscapeSnapshotCacheType;
          ready_count: number;
          stale_count: number;
          expired_ready_count: number;
          oldest_generated_at: string | null;
          latest_generated_at: string | null;
          latest_expires_at: string | null;
          estimated_payload_bytes: number;
        },
        [string]
      >(
        `
          select
            snapshot_type,
            sum(case when status = 'ready' then 1 else 0 end) as ready_count,
            sum(case when status = 'stale' then 1 else 0 end) as stale_count,
            sum(case
              when status = 'ready'
                and expires_at is not null
                and datetime(expires_at) <= datetime(?)
              then 1 else 0
            end) as expired_ready_count,
            min(generated_at) as oldest_generated_at,
            max(generated_at) as latest_generated_at,
            max(expires_at) as latest_expires_at,
            coalesce(sum(length(payload)), 0) as estimated_payload_bytes
          from landscape_snapshots
          group by snapshot_type
        `,
      )
      .all(now.toISOString());

    return rows
      .filter(
        (row): row is typeof row & { snapshot_type: LandscapeSnapshotCacheType } =>
          row.snapshot_type === "landscape_snapshot" ||
          row.snapshot_type === "landscape_replay_snapshot" ||
          row.snapshot_type === "landscape_replay_comparison",
      )
      .map((row) => ({
        snapshotType: row.snapshot_type,
        readyCount: Number(row.ready_count ?? 0),
        staleCount: Number(row.stale_count ?? 0),
        expiredReadyCount: Number(row.expired_ready_count ?? 0),
        oldestGeneratedAt: asNullableDate(row.oldest_generated_at),
        latestGeneratedAt: asNullableDate(row.latest_generated_at),
        latestExpiresAt: asNullableDate(row.latest_expires_at),
        estimatedPayloadBytes: Number(row.estimated_payload_bytes ?? 0),
      }));
  }

  const rows = await db
    .select({
      snapshotType: landscapeSnapshots.snapshotType,
      readyCount: sql<number>`count(*) filter (where ${landscapeSnapshots.status} = 'ready')::int`,
      staleCount: sql<number>`count(*) filter (where ${landscapeSnapshots.status} = 'stale')::int`,
      expiredReadyCount: sql<number>`count(*) filter (
        where ${landscapeSnapshots.status} = 'ready'
          and ${landscapeSnapshots.expiresAt} is not null
          and ${landscapeSnapshots.expiresAt} <= ${now}
      )::int`,
      oldestGeneratedAt: sql<Date | null>`min(${landscapeSnapshots.generatedAt})`,
      latestGeneratedAt: sql<Date | null>`max(${landscapeSnapshots.generatedAt})`,
      latestExpiresAt: sql<Date | null>`max(${landscapeSnapshots.expiresAt})`,
      estimatedPayloadBytes: sql<number>`coalesce(sum(octet_length(${landscapeSnapshots.payload}::text)), 0)::int`,
    })
    .from(landscapeSnapshots)
    .groupBy(landscapeSnapshots.snapshotType);

  return rows
    .filter(
      (row): row is typeof row & { snapshotType: LandscapeSnapshotCacheType } =>
        row.snapshotType === "landscape_snapshot" ||
        row.snapshotType === "landscape_replay_snapshot" ||
        row.snapshotType === "landscape_replay_comparison",
    )
    .map((row) => ({
      snapshotType: row.snapshotType,
      readyCount: row.readyCount,
      staleCount: row.staleCount,
      expiredReadyCount: row.expiredReadyCount,
      oldestGeneratedAt: row.oldestGeneratedAt,
      latestGeneratedAt: row.latestGeneratedAt,
      latestExpiresAt: row.latestExpiresAt,
      estimatedPayloadBytes: row.estimatedPayloadBytes,
    }));
}

export async function deleteLandscapeSnapshotCacheRows(input?: {
  snapshotTypes?: LandscapeSnapshotCacheType[];
}): Promise<number> {
  const snapshotTypes = input?.snapshotTypes ?? [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const result =
      snapshotTypes.length > 0
        ? sqlite.db
            .query(
              `delete from landscape_snapshots where snapshot_type in (${placeholders(snapshotTypes)})`,
            )
            .run(...snapshotTypes)
        : sqlite.db.query("delete from landscape_snapshots").run();
    return Number(result.changes);
  }

  const deletedRows =
    snapshotTypes.length > 0
      ? await db
          .delete(landscapeSnapshots)
          .where(inArray(landscapeSnapshots.snapshotType, snapshotTypes))
          .returning({ id: landscapeSnapshots.id })
      : await db.delete(landscapeSnapshots).returning({ id: landscapeSnapshots.id });

  return deletedRows.length;
}

export async function deleteStaleOrExpiredLandscapeSnapshotCacheRows(input?: {
  snapshotTypes?: LandscapeSnapshotCacheType[];
  now?: Date;
}): Promise<{
  deletedCount: number;
  staleDeletedCount: number;
  expiredDeletedCount: number;
  bySnapshotType: Record<
    LandscapeSnapshotCacheType,
    { deletedCount: number; staleDeletedCount: number; expiredDeletedCount: number }
  >;
}> {
  const now = input?.now ?? new Date();
  const snapshotTypes = input?.snapshotTypes ?? [];
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const typeClause =
      snapshotTypes.length > 0 ? `and snapshot_type in (${placeholders(snapshotTypes)})` : "";
    const targetRows = sqlite.db
      .query<
        {
          id: string;
          snapshot_type: LandscapeSnapshotCacheType;
          status: string;
          expires_at: string | null;
        },
        unknown[]
      >(
        `
          select id, snapshot_type, status, expires_at
          from landscape_snapshots
          where ${snapshotTypes.length > 0 ? "1 = 1" : "1 = 1"}
            ${typeClause}
            and (
              status = 'stale'
              or (
                status = 'ready'
                and expires_at is not null
                and datetime(expires_at) <= datetime(?)
              )
            )
        `,
      )
      .all(...snapshotTypes, now.toISOString());
    if (targetRows.length === 0) return emptyDeleteSummary();

    const summary = emptyDeleteSummary();
    summary.staleDeletedCount = targetRows.filter((row) => row.status === "stale").length;
    summary.expiredDeletedCount = targetRows.filter(
      (row) =>
        row.status === "ready" &&
        row.expires_at !== null &&
        asDate(row.expires_at).getTime() <= now.getTime(),
    ).length;
    for (const row of targetRows) {
      const perType = summary.bySnapshotType[row.snapshot_type];
      if (!perType) continue;
      perType.deletedCount += 1;
      if (row.status === "stale") {
        perType.staleDeletedCount += 1;
      } else if (row.expires_at !== null && asDate(row.expires_at).getTime() <= now.getTime()) {
        perType.expiredDeletedCount += 1;
      }
    }

    const ids = targetRows.map((row) => row.id);
    const result = sqlite.db
      .query(`delete from landscape_snapshots where id in (${placeholders(ids)})`)
      .run(...ids);
    summary.deletedCount = Number(result.changes);
    return summary;
  }

  const where = and(
    snapshotTypes.length > 0 ? inArray(landscapeSnapshots.snapshotType, snapshotTypes) : undefined,
    or(
      eq(landscapeSnapshots.status, "stale"),
      and(
        eq(landscapeSnapshots.status, "ready"),
        sql`${landscapeSnapshots.expiresAt} IS NOT NULL`,
        lte(landscapeSnapshots.expiresAt, now),
      ),
    ),
  );

  const targetRows = await db
    .select({
      id: landscapeSnapshots.id,
      snapshotType: landscapeSnapshots.snapshotType,
      status: landscapeSnapshots.status,
      expiresAt: landscapeSnapshots.expiresAt,
    })
    .from(landscapeSnapshots)
    .where(where);

  if (targetRows.length === 0) {
    return {
      deletedCount: 0,
      staleDeletedCount: 0,
      expiredDeletedCount: 0,
      bySnapshotType: {
        landscape_snapshot: { deletedCount: 0, staleDeletedCount: 0, expiredDeletedCount: 0 },
        landscape_replay_snapshot: {
          deletedCount: 0,
          staleDeletedCount: 0,
          expiredDeletedCount: 0,
        },
        landscape_replay_comparison: {
          deletedCount: 0,
          staleDeletedCount: 0,
          expiredDeletedCount: 0,
        },
      },
    };
  }

  const bySnapshotType: Record<
    LandscapeSnapshotCacheType,
    { deletedCount: number; staleDeletedCount: number; expiredDeletedCount: number }
  > = {
    landscape_snapshot: { deletedCount: 0, staleDeletedCount: 0, expiredDeletedCount: 0 },
    landscape_replay_snapshot: { deletedCount: 0, staleDeletedCount: 0, expiredDeletedCount: 0 },
    landscape_replay_comparison: {
      deletedCount: 0,
      staleDeletedCount: 0,
      expiredDeletedCount: 0,
    },
  };
  const staleDeletedCount = targetRows.filter((row) => row.status === "stale").length;
  const expiredDeletedCount = targetRows.filter(
    (row) =>
      row.status === "ready" &&
      row.expiresAt instanceof Date &&
      row.expiresAt.getTime() <= now.getTime(),
  ).length;
  for (const row of targetRows) {
    const perType = bySnapshotType[row.snapshotType as LandscapeSnapshotCacheType];
    if (!perType) continue;
    perType.deletedCount += 1;
    if (row.status === "stale") {
      perType.staleDeletedCount += 1;
    } else if (row.expiresAt instanceof Date && row.expiresAt.getTime() <= now.getTime()) {
      perType.expiredDeletedCount += 1;
    }
  }

  const deletedRows = await db
    .delete(landscapeSnapshots)
    .where(
      inArray(
        landscapeSnapshots.id,
        targetRows.map((row) => row.id),
      ),
    )
    .returning({ id: landscapeSnapshots.id });

  return {
    deletedCount: deletedRows.length,
    staleDeletedCount,
    expiredDeletedCount,
    bySnapshotType,
  };
}
