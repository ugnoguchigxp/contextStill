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

  test("covers stableStringify for arrays and nested objects", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    const build = vi.fn().mockResolvedValue({ built: true });

    await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: {
        arr: [1, 2, { nested: true }],
        obj: { b: 2, a: 1, val: null },
        bool: true,
        str: "hello",
      },
      build,
    });
    expect(findLandscapeSnapshotCacheMock).toHaveBeenCalledTimes(1);
  });

  test("covers cacheTtlSeconds defaults when env value is invalid or non-positive", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    process.env.LANDSCAPE_SNAPSHOT_CACHE_TTL_SECONDS = "invalid-ttl";
    const build = vi.fn().mockResolvedValue({ built: true });

    await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: { a: 1 },
      build,
    });
    expect(upsertLandscapeSnapshotCacheMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlSeconds: 300,
      }),
    );

    process.env.LANDSCAPE_SNAPSHOT_CACHE_TTL_SECONDS = "-10";
    await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: { a: 1 },
      build,
    });
    expect(upsertLandscapeSnapshotCacheMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ttlSeconds: 300,
      }),
    );
  });

  test("covers loadLastPurgeBySnapshotType with partial/full audit logs and errors", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    listAuditLogsMock.mockResolvedValue({
      items: [
        {
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          payload: {
            requestedSnapshotTypes: ["landscape_snapshot"],
            staleDeletedCount: 1,
            expiredDeletedCount: 2,
            deletedCount: 3,
            purgedAt: "2026-05-24T00:00:00.000Z",
            error: null,
          },
        },
        {
          createdAt: new Date("2026-05-24T00:01:00.000Z"),
          payload: {
            requestedSnapshotTypes: "not-an-array",
          },
        },
        {
          createdAt: new Date("2026-05-24T00:02:00.000Z"),
          payload: {
            requestedSnapshotTypes: ["landscape_replay_snapshot", "landscape_replay_comparison"],
            staleDeletedCount: 0,
            expiredDeletedCount: 0,
            deletedCount: 0,
            purgedAt: null,
            error: "some-error",
          },
        },
      ],
    });

    const status = await getLandscapeSnapshotCacheStatus();
    expect(status.snapshots).toHaveLength(3);
    const snap1 = status.snapshots.find((s) => s.snapshotType === "landscape_snapshot");
    expect(snap1?.lastPurge).not.toBeNull();
    expect(snap1?.lastPurge?.deletedCount).toBe(3);

    const snap2 = status.snapshots.find((s) => s.snapshotType === "landscape_replay_snapshot");
    expect(snap2?.lastPurge).not.toBeNull();
    expect(snap2?.lastPurge?.error).toBe("some-error");

    listAuditLogsMock.mockRejectedValue(new Error("db error"));
    const statusError = await getLandscapeSnapshotCacheStatus();
    expect(statusError.snapshots.every((s) => s.lastPurge === null)).toBe(true);
  });

  test("covers purgeLandscapeSnapshotCache error handling", async () => {
    deleteStaleOrExpiredLandscapeSnapshotCacheRowsMock.mockRejectedValue(new Error("purge failed"));
    const result = await purgeLandscapeSnapshotCache({
      snapshotTypes: ["landscape_snapshot"],
    });

    expect(result.deletedCount).toBe(0);
    expect(result.error).toBe("purge failed");
    expect(recordAuditLogSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "system",
        eventType: "LANDSCAPE_SNAPSHOT_CACHE_PURGE",
      }),
    );
  });

  test("covers runWithLandscapeSnapshotCache write failure", async () => {
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
    upsertLandscapeSnapshotCacheMock.mockRejectedValue(new Error("write failed"));
    const build = vi.fn().mockResolvedValue({ built: true });

    const result = await runWithLandscapeSnapshotCache({
      snapshotType: "landscape_snapshot",
      params: { a: 1 },
      build,
    });

    expect(result).toEqual({ built: true });
    expect(recordAuditLogSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LANDSCAPE_SNAPSHOT_CACHE_WRITE_FAILED",
      }),
    );
  });
});
