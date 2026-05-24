import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  findLandscapeSnapshotCacheMock,
  upsertLandscapeSnapshotCacheMock,
  markExpiredLandscapeSnapshotCacheAsStaleMock,
  listLandscapeSnapshotCacheSummaryRowsMock,
  deleteStaleOrExpiredLandscapeSnapshotCacheRowsMock,
  listAuditLogsMock,
  recordAuditLogSafeMock,
} = vi.hoisted(() => ({
  findLandscapeSnapshotCacheMock: vi.fn(),
  upsertLandscapeSnapshotCacheMock: vi.fn(),
  markExpiredLandscapeSnapshotCacheAsStaleMock: vi.fn(),
  listLandscapeSnapshotCacheSummaryRowsMock: vi.fn(),
  deleteStaleOrExpiredLandscapeSnapshotCacheRowsMock: vi.fn(),
  listAuditLogsMock: vi.fn(),
  recordAuditLogSafeMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-snapshot-cache.repository.js", async () => {
  const actual = await vi.importActual(
    "../src/modules/landscape/landscape-snapshot-cache.repository.js",
  );
  return {
    ...actual,
    findLandscapeSnapshotCache: findLandscapeSnapshotCacheMock,
    upsertLandscapeSnapshotCache: upsertLandscapeSnapshotCacheMock,
    markExpiredLandscapeSnapshotCacheAsStale: markExpiredLandscapeSnapshotCacheAsStaleMock,
    listLandscapeSnapshotCacheSummaryRows: listLandscapeSnapshotCacheSummaryRowsMock,
    deleteStaleOrExpiredLandscapeSnapshotCacheRows:
      deleteStaleOrExpiredLandscapeSnapshotCacheRowsMock,
  };
});

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    landscapeSnapshotCacheReadFailed: "LANDSCAPE_SNAPSHOT_CACHE_READ_FAILED",
    landscapeSnapshotCacheWriteFailed: "LANDSCAPE_SNAPSHOT_CACHE_WRITE_FAILED",
    landscapeSnapshotCachePurge: "LANDSCAPE_SNAPSHOT_CACHE_PURGE",
  },
  listAuditLogs: listAuditLogsMock,
  recordAuditLogSafe: recordAuditLogSafeMock,
}));

import {
  getLandscapeSnapshotCacheStatus,
  purgeLandscapeSnapshotCache,
  runWithLandscapeSnapshotCache,
} from "../src/modules/landscape/landscape-snapshot-cache.service.js";

describe("landscape snapshot cache service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = undefined;
    process.env.LANDSCAPE_SNAPSHOT_CACHE_TTL_SECONDS = undefined;
    findLandscapeSnapshotCacheMock.mockResolvedValue(null);
    upsertLandscapeSnapshotCacheMock.mockResolvedValue(undefined);
    markExpiredLandscapeSnapshotCacheAsStaleMock.mockResolvedValue(0);
    listLandscapeSnapshotCacheSummaryRowsMock.mockResolvedValue([]);
    listAuditLogsMock.mockResolvedValue({ items: [] });
    recordAuditLogSafeMock.mockResolvedValue(undefined);
    deleteStaleOrExpiredLandscapeSnapshotCacheRowsMock.mockResolvedValue({
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
    });
  });

  test("bypasses cache when disabled", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "false";
    const build = vi.fn().mockResolvedValue({ ok: true });

    const result = await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: { a: 1 },
      build,
    });

    expect(result).toEqual({ ok: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(findLandscapeSnapshotCacheMock).not.toHaveBeenCalled();
    expect(upsertLandscapeSnapshotCacheMock).not.toHaveBeenCalled();
  });

  test("returns cached payload when cache hit", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    findLandscapeSnapshotCacheMock.mockResolvedValue({
      payload: { cached: true },
    });
    const build = vi.fn().mockResolvedValue({ cached: false });

    const result = await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: { a: 1 },
      build,
    });

    expect(result).toEqual({ cached: true });
    expect(build).not.toHaveBeenCalled();
    expect(upsertLandscapeSnapshotCacheMock).not.toHaveBeenCalled();
  });

  test("continues when stale-marker update fails", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    markExpiredLandscapeSnapshotCacheAsStaleMock.mockRejectedValue(new Error("db failure"));
    const build = vi.fn().mockResolvedValue({ built: true });

    const result = await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_replay_snapshot",
      params: { windowDays: 30 },
      build,
    });

    expect(result).toEqual({ built: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(findLandscapeSnapshotCacheMock).toHaveBeenCalledTimes(1);
    expect(upsertLandscapeSnapshotCacheMock).toHaveBeenCalledTimes(1);
  });

  test("records read failure audit and continues build path", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    findLandscapeSnapshotCacheMock.mockRejectedValueOnce(new Error("read failed"));
    const build = vi.fn().mockResolvedValue({ built: true });

    const result = await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: { a: 1 },
      build,
    });

    expect(result).toEqual({ built: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(recordAuditLogSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LANDSCAPE_SNAPSHOT_CACHE_READ_FAILED",
      }),
    );
  });

  test("returns extended status even when disabled", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "false";
    listLandscapeSnapshotCacheSummaryRowsMock.mockResolvedValue([
      {
        snapshotType: "landscape_snapshot",
        readyCount: 1,
        staleCount: 2,
        expiredReadyCount: 1,
        oldestGeneratedAt: new Date("2026-05-24T00:00:00.000Z"),
        latestGeneratedAt: new Date("2026-05-24T00:10:00.000Z"),
        latestExpiresAt: new Date("2026-05-24T00:15:00.000Z"),
        estimatedPayloadBytes: 2048,
      },
    ]);

    const status = await getLandscapeSnapshotCacheStatus();

    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toContain("LANDSCAPE_SNAPSHOT_CACHE_ENABLED");
    expect(status.snapshots).toHaveLength(3);
    expect(status.snapshots[0]).toMatchObject({
      snapshotType: "landscape_snapshot",
      readyCount: 1,
      staleCount: 2,
      expiredReadyCount: 1,
      estimatedPayloadBytes: 2048,
    });
  });

  test("purge deletes only stale/expired rows and records audit", async () => {
    deleteStaleOrExpiredLandscapeSnapshotCacheRowsMock.mockResolvedValueOnce({
      deletedCount: 3,
      staleDeletedCount: 2,
      expiredDeletedCount: 1,
      bySnapshotType: {
        landscape_snapshot: { deletedCount: 1, staleDeletedCount: 1, expiredDeletedCount: 0 },
        landscape_replay_snapshot: {
          deletedCount: 2,
          staleDeletedCount: 1,
          expiredDeletedCount: 1,
        },
        landscape_replay_comparison: {
          deletedCount: 0,
          staleDeletedCount: 0,
          expiredDeletedCount: 0,
        },
      },
    });

    const result = await purgeLandscapeSnapshotCache({
      snapshotTypes: ["landscape_snapshot", "landscape_replay_snapshot"],
    });

    expect(result.deletedCount).toBe(3);
    expect(result.staleDeletedCount).toBe(2);
    expect(result.expiredDeletedCount).toBe(1);
    expect(result.bySnapshotType.landscape_snapshot.deletedCount).toBe(1);
    expect(result.bySnapshotType.landscape_replay_snapshot.deletedCount).toBe(2);
    expect(recordAuditLogSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LANDSCAPE_SNAPSHOT_CACHE_PURGE",
      }),
    );
  });
});
