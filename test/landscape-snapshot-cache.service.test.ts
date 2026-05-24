import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  findLandscapeSnapshotCacheMock,
  upsertLandscapeSnapshotCacheMock,
  markExpiredLandscapeSnapshotCacheAsStaleMock,
} = vi.hoisted(() => ({
  findLandscapeSnapshotCacheMock: vi.fn(),
  upsertLandscapeSnapshotCacheMock: vi.fn(),
  markExpiredLandscapeSnapshotCacheAsStaleMock: vi.fn(),
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
  };
});

import { runWithLandscapeSnapshotCache } from "../src/modules/landscape/landscape-snapshot-cache.service.js";

describe("landscape snapshot cache service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = undefined;
    process.env.LANDSCAPE_SNAPSHOT_CACHE_TTL_SECONDS = undefined;
    findLandscapeSnapshotCacheMock.mockResolvedValue(null);
    upsertLandscapeSnapshotCacheMock.mockResolvedValue(undefined);
    markExpiredLandscapeSnapshotCacheAsStaleMock.mockResolvedValue(0);
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
});
