import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
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
  latestGeneratedAt: Date | null;
  latestExpiresAt: Date | null;
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
  const rows = await db
    .select({
      snapshotType: landscapeSnapshots.snapshotType,
      readyCount: sql<number>`count(*) filter (where ${landscapeSnapshots.status} = 'ready')::int`,
      staleCount: sql<number>`count(*) filter (where ${landscapeSnapshots.status} = 'stale')::int`,
      latestGeneratedAt: sql<Date | null>`max(${landscapeSnapshots.generatedAt})`,
      latestExpiresAt: sql<Date | null>`max(${landscapeSnapshots.expiresAt})`,
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
      latestGeneratedAt: row.latestGeneratedAt,
      latestExpiresAt: row.latestExpiresAt,
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
