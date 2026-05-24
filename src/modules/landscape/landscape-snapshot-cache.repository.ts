import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
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

export async function findLandscapeSnapshotCache(input: {
  snapshotType: LandscapeSnapshotCacheType;
  paramsHash: string;
  now?: Date;
}): Promise<LandscapeSnapshotCacheRow | null> {
  const now = input.now ?? new Date();
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
      estimatedPayloadBytes:
        sql<number>`coalesce(sum(octet_length(${landscapeSnapshots.payload}::text)), 0)::int`,
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
    .where(inArray(landscapeSnapshots.id, targetRows.map((row) => row.id)))
    .returning({ id: landscapeSnapshots.id });

  return {
    deletedCount: deletedRows.length,
    staleDeletedCount,
    expiredDeletedCount,
    bySnapshotType,
  };
}
