import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileLockState } from "../src/cli/file-lock.js";
import { getDb } from "../src/db/index.js";
import { runDistillationRepair } from "../src/modules/distillationRepair/repair.service.js";
import { isManualPauseTarget } from "../src/modules/selectDistillationTarget/manual-pause.js";
import {
  recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets,
} from "../src/modules/selectDistillationTarget/repository.js";

vi.mock("node:fs/promises", () => ({
  default: {
    unlink: vi.fn(),
  },
}));

vi.mock("../src/cli/file-lock.js", () => ({
  readFileLockState: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../src/modules/selectDistillationTarget/manual-pause.js", () => ({
  isManualPauseTarget: vi.fn(),
}));

vi.mock("../src/modules/selectDistillationTarget/repository.js", () => ({
  DEFAULT_DISTILLATION_TARGET_VERSION: "v1",
  recoverStaleDistillationTargets: vi.fn(),
  releaseRetryablePausedDistillationTargets: vi.fn(),
}));

describe("Distillation Repair Service", () => {
  const mockDb = {
    select: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDb as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(isManualPauseTarget).mockReturnValue(false);

    // デフォルトのロック状態（存在しない）
    vi.mocked(readFileLockState).mockResolvedValue({
      exists: false,
      staleByCreatedAge: false,
      processAlive: false,
      path: "/tmp/lock",
      pid: 0,
      createdAt: null,
      ageSeconds: 0,
    });
  });

  const setupDbMock = (rows: any[]) => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    };
    mockDb.select.mockReturnValue(chain);
  };

  it("returns report with dry-run mode and empty queue stats by default", async () => {
    setupDbMock([]);

    const report = await runDistillationRepair({
      kind: "auto",
      apply: false,
    });

    expect(report.mode).toBe("dry-run");
    expect(report.kind).toBe("auto");
    expect(report.actions).toEqual([]);
    expect(report.applied.removedLocks).toBe(0);
  });

  it("handles inspect_live_worker action when file lock exists, is stale, but owner pid is alive", async () => {
    setupDbMock([]);
    vi.mocked(readFileLockState).mockResolvedValue({
      exists: true,
      staleByCreatedAge: true,
      processAlive: true,
      path: "/tmp/lock",
      pid: 1234,
      createdAt: new Date(Date.now() - 1000 * 1000).toISOString(),
      ageSeconds: 1000,
    });

    const report = await runDistillationRepair();
    const action = report.actions.find((a) => a.type === "inspect_live_worker");
    expect(action).toBeDefined();
    expect(action?.safeToApply).toBe(false);
    expect(action?.requiresManualReview).toBe(true);
  });

  it("handles running_target_holds_lock action when lock is stale, owner process is dead, but there are recent running targets in DB", async () => {
    const now = new Date();
    setupDbMock([
      {
        id: "1",
        targetKind: "wiki_file",
        status: "running",
        createdAt: now,
        lockedAt: now,
        heartbeatAt: now,
        updatedAt: now,
      },
    ]);

    vi.mocked(readFileLockState).mockResolvedValue({
      exists: true,
      staleByCreatedAge: true,
      processAlive: false,
      path: "/tmp/lock",
      pid: 1234,
      createdAt: new Date(Date.now() - 1000 * 1000).toISOString(),
      ageSeconds: 1000,
    });

    const report = await runDistillationRepair();
    const action = report.actions.find((a) => a.type === "running_target_holds_lock");
    expect(action).toBeDefined();
    expect(action?.safeToApply).toBe(false);
  });

  it("handles remove_stale_file_lock action when lock is stale, owner process is dead, and no recent running targets", async () => {
    setupDbMock([]);
    vi.mocked(readFileLockState).mockResolvedValue({
      exists: true,
      staleByCreatedAge: true,
      processAlive: false,
      path: "/tmp/lock",
      pid: 1234,
      createdAt: new Date(Date.now() - 1000 * 1000).toISOString(),
      ageSeconds: 1000,
    });

    const report = await runDistillationRepair();
    const action = report.actions.find((a) => a.type === "remove_stale_file_lock");
    expect(action).toBeDefined();
    expect(action?.safeToApply).toBe(true);
  });

  it("handles release_stale_running action when there are stale running targets in queue", async () => {
    const staleTime = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    setupDbMock([
      {
        id: "1",
        targetKind: "wiki_file",
        status: "running",
        createdAt: staleTime,
        lockedAt: staleTime,
        heartbeatAt: staleTime,
        updatedAt: staleTime,
      },
    ]);

    const report = await runDistillationRepair({ staleSeconds: 600 });
    const action = report.actions.find((a) => a.type === "release_stale_running");
    expect(action).toBeDefined();
    expect(action?.safeToApply).toBe(true);
    expect(report.skipped.recentRunning).toBe(0);
  });

  it("handles release_retryable_paused and manual_paused actions", async () => {
    const now = new Date();
    const nextRetry = new Date(Date.now() - 60 * 1000); // in the past

    // isManualPauseTarget mock behaves differently for rows
    vi.mocked(isManualPauseTarget).mockImplementation((row: any) => row.id === "manual-paused-row");

    setupDbMock([
      {
        id: "retry-row",
        targetKind: "wiki_file",
        status: "paused",
        createdAt: now,
        lockedAt: now,
        heartbeatAt: now,
        updatedAt: now,
        nextRetryAt: nextRetry,
      },
      {
        id: "manual-paused-row",
        targetKind: "wiki_file",
        status: "paused",
        createdAt: now,
        lockedAt: now,
        heartbeatAt: now,
        updatedAt: now,
        nextRetryAt: null,
      },
    ]);

    const report = await runDistillationRepair();
    expect(report.actions.some((a) => a.type === "release_retryable_paused")).toBe(true);
    expect(report.actions.some((a) => a.type === "manual_paused")).toBe(true);
    expect(report.skipped.manualPaused).toBe(1);
  });

  it("detects queue_stopped when queue has pending targets but no worker runs them", async () => {
    const ancientTime = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    setupDbMock([
      {
        id: "1",
        targetKind: "wiki_file",
        status: "pending",
        createdAt: ancientTime,
        lockedAt: null,
        heartbeatAt: null,
        updatedAt: ancientTime,
      },
    ]);

    const report = await runDistillationRepair();
    const action = report.actions.find((a) => a.type === "queue_stopped");
    expect(action).toBeDefined();
    expect(action?.safeToApply).toBe(false);
  });

  it("handles blocked_by_higher_priority when blocked by higher priority kind rows", async () => {
    setupDbMock([
      {
        id: "blocker-1",
        targetKind: "knowledge_candidate",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const report = await runDistillationRepair({
      kind: "wiki", // wiki_file is lower priority than knowledge_candidate
    });

    const action = report.actions.find((a) => a.type === "blocked_by_higher_priority");
    expect(action).toBeDefined();
    expect(action?.safeToApply).toBe(false);
    expect(report.skipped.blockedByHigherPriority).toBe(1);
  });

  it("handles apply mode successfully for safe actions", async () => {
    setupDbMock([]);

    // ロックファイル存在
    vi.mocked(readFileLockState).mockResolvedValue({
      exists: true,
      staleByCreatedAge: true,
      processAlive: false,
      path: "/tmp/lock",
      pid: 1234,
      createdAt: new Date(Date.now() - 1000 * 1000).toISOString(),
      ageSeconds: 1000,
    });

    // モックの戻り値
    vi.mocked(recoverStaleDistillationTargets).mockResolvedValue({
      recoveredToPending: 3,
      failed: 0,
      skipped: 1,
    });
    vi.mocked(releaseRetryablePausedDistillationTargets).mockResolvedValue(5);

    // テスト対象にアクションを追加させるためのモック
    const staleTime = new Date(Date.now() - 3600 * 1000);
    setupDbMock([
      {
        id: "1",
        targetKind: "wiki_file",
        status: "running",
        createdAt: staleTime,
        lockedAt: staleTime,
        heartbeatAt: staleTime,
        updatedAt: staleTime,
      },
      {
        id: "2",
        targetKind: "wiki_file",
        status: "paused",
        createdAt: staleTime,
        lockedAt: staleTime,
        heartbeatAt: staleTime,
        updatedAt: staleTime,
        nextRetryAt: staleTime,
      },
    ]);

    const report = await runDistillationRepair({
      apply: true,
    });

    expect(report.mode).toBe("apply");
    expect(fs.unlink).toHaveBeenCalled();
    expect(recoverStaleDistillationTargets).toHaveBeenCalled();
    expect(releaseRetryablePausedDistillationTargets).toHaveBeenCalled();

    expect(report.applied.removedLocks).toBe(1);
    expect(report.applied.releasedStaleRunning).toBe(3);
    expect(report.applied.skippedStaleRunning).toBe(1);
    expect(report.applied.releasedRetryablePaused).toBe(5);
  });

  it("adds warning if unlink fails in apply mode", async () => {
    setupDbMock([]);
    vi.mocked(readFileLockState).mockResolvedValue({
      exists: true,
      staleByCreatedAge: true,
      processAlive: false,
      path: "/tmp/lock",
      pid: 1234,
      createdAt: new Date(Date.now() - 1000 * 1000).toISOString(),
      ageSeconds: 1000,
    });

    vi.mocked(fs.unlink).mockRejectedValue(new Error("Permission denied"));

    const report = await runDistillationRepair({
      apply: true,
    });

    expect(report.warnings).toContain("Permission denied");
    expect(report.applied.removedLocks).toBe(0);
  });
});
