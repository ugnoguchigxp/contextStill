import { createHash } from "node:crypto";
import { landscapeSnapshotCacheTypeValues } from "../../db/schema.js";
import {
  deleteLandscapeSnapshotCacheRows,
  findLandscapeSnapshotCache,
  listLandscapeSnapshotCacheSummaryRows,
  markExpiredLandscapeSnapshotCacheAsStale,
  type LandscapeSnapshotCacheType,
  upsertLandscapeSnapshotCache,
} from "./landscape-snapshot-cache.repository.js";

export type { LandscapeSnapshotCacheType } from "./landscape-snapshot-cache.repository.js";

const DEFAULT_TTL_SECONDS = 5 * 60;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function cacheEnabled(): boolean {
  const raw = (process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED ?? "false").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function cacheTtlSeconds(): number {
  const parsed = Number(process.env.LANDSCAPE_SNAPSHOT_CACHE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.trunc(parsed);
}

function cacheHash(params: Record<string, unknown>): string {
  return createHash("sha1").update(stableStringify(params)).digest("hex");
}

export type LandscapeSnapshotCacheStatus = {
  generatedAt: string;
  enabled: boolean;
  ttlSeconds: number;
  snapshots: Array<{
    snapshotType: LandscapeSnapshotCacheType;
    readyCount: number;
    staleCount: number;
    latestGeneratedAt: string | null;
    latestExpiresAt: string | null;
  }>;
};

function toIsoStringOrNull(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

export function isLandscapeSnapshotCacheEnabled(): boolean {
  return cacheEnabled();
}

export function landscapeSnapshotCacheTtlSeconds(): number {
  return cacheTtlSeconds();
}

export async function getLandscapeSnapshotCacheStatus(): Promise<LandscapeSnapshotCacheStatus> {
  const summaryRows = await listLandscapeSnapshotCacheSummaryRows();
  const rowByType = new Map(summaryRows.map((row) => [row.snapshotType, row]));

  return {
    generatedAt: new Date().toISOString(),
    enabled: cacheEnabled(),
    ttlSeconds: cacheTtlSeconds(),
    snapshots: landscapeSnapshotCacheTypeValues.map((snapshotType) => {
      const row = rowByType.get(snapshotType);
      return {
        snapshotType,
        readyCount: row?.readyCount ?? 0,
        staleCount: row?.staleCount ?? 0,
        latestGeneratedAt: toIsoStringOrNull(row?.latestGeneratedAt ?? null),
        latestExpiresAt: toIsoStringOrNull(row?.latestExpiresAt ?? null),
      };
    }),
  };
}

export async function clearLandscapeSnapshotCache(input?: {
  snapshotTypes?: LandscapeSnapshotCacheType[];
}): Promise<number> {
  return deleteLandscapeSnapshotCacheRows(input);
}

export async function runWithLandscapeSnapshotCache<T extends Record<string, unknown>>(input: {
  snapshotType: LandscapeSnapshotCacheType;
  params: Record<string, unknown>;
  build: () => Promise<T>;
}): Promise<T> {
  if (!cacheEnabled()) {
    return input.build();
  }

  const ttlSeconds = cacheTtlSeconds();
  const paramsHash = cacheHash(input.params);
  try {
    void markExpiredLandscapeSnapshotCacheAsStale().catch(() => undefined);
    const cached = await findLandscapeSnapshotCache({
      snapshotType: input.snapshotType,
      paramsHash,
    });
    if (cached) {
      return cached.payload as T;
    }
  } catch {
    // cache read failure should not block caller
  }

  const built = await input.build();

  try {
    await upsertLandscapeSnapshotCache({
      snapshotType: input.snapshotType,
      paramsHash,
      params: input.params,
      payload: built,
      ttlSeconds,
    });
  } catch {
    // cache write failure should not block caller
  }

  return built;
}
